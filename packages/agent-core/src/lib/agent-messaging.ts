import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import { getSession } from './sessions';
import { getRecentMessages } from './messages';
import { sendWorkerEvent, sendWebappEvent } from './events';
import { getOrCreateWorkerInstance } from './worker-manager';
import { renderAgentMessage, sanitizeSenderLabel } from './prompt';
import { getCustomAgent } from './custom-agent';
import { getPreferences } from './preferences';
import {
  shouldSuppressDuplicateMessage,
  shouldSuppressDuplicateAck,
  DEFAULT_DEDUP_WINDOW_MS,
  RecentMessageForDedup,
} from './message-dedup';
import { MessageItem, SessionItem } from '../schema';

/**
 * Resolve the display name for a session's agent.
 * Priority: agentName > custom agent name > default agent name > title > "Assistant"
 */
export async function resolveAgentDisplayName(session: SessionItem): Promise<string> {
  if (session.agentName) return session.agentName;

  if (session.customAgentId) {
    const customAgent = await getCustomAgent(session.customAgentId);
    if (customAgent?.name) return customAgent.name;
  }

  const prefs = await getPreferences();
  if (prefs.defaultAgentName) return prefs.defaultAgentName;

  return session.title || 'Assistant';
}

export interface SendAgentMessageParams {
  senderWorkerId: string;
  targetSessionIds: string[];
  message: string;
  /** If true, message is saved but target worker is NOT woken up */
  acknowledge?: boolean;
}

export interface SendAgentMessageResult {
  sent: string[];
  failed: { sessionId: string; reason: string }[];
}

/**
 * Send a message from one agent session to one or more target sessions.
 * No routing restrictions - any session can message any other session by ID.
 */
export async function sendAgentMessage(params: SendAgentMessageParams): Promise<SendAgentMessageResult> {
  const { senderWorkerId, targetSessionIds, message, acknowledge } = params;

  const uniqueTargetSessionIds = [...new Set(targetSessionIds)];

  const senderSession = await getSession(senderWorkerId);
  if (!senderSession) {
    return {
      sent: [],
      failed: uniqueTargetSessionIds.map((id) => ({ sessionId: id, reason: 'Sender session not found' })),
    };
  }

  const senderName = await resolveAgentDisplayName(senderSession);
  const result: SendAgentMessageResult = { sent: [], failed: [] };

  for (const targetId of uniqueTargetSessionIds) {
    try {
      if (targetId === senderWorkerId) {
        result.failed.push({ sessionId: targetId, reason: 'Cannot send message to self' });
        continue;
      }

      const targetSession = await getSession(targetId);
      if (!targetSession) {
        result.failed.push({ sessionId: targetId, reason: 'Session not found' });
        continue;
      }

      const now = Date.now();

      // Resurrection re-emit dedup: a child turn interrupted mid-flight (wedged kiro-cli /
      // cancellation) re-runs on auto-retrigger and the model re-emits
      // essentially the same message it already sent before the interruption
      // (observed: two "starting the deployment …" intros ~62s apart). Suppress a
      // conservative near-duplicate of a message THIS sender already delivered
      // to THIS target inside the recent window. We read the sender's own
      // communicationLog mirror (which stores the raw outgoing `message`) so
      // the check is symmetric with how outgoing messages are persisted below.
      // Conservative by design — see message-dedup.ts: short messages are never
      // deduped and only a long identical-prefix / exact match fires.
      //
      // The look-back is scoped at the DynamoDB layer to just the dedup window
      // (`getRecentMessages` issues a `SK >= cutoff` KeyCondition) so we read
      // only the last ~5 minutes of rows instead of the full session history —
      // the in-memory `messageType` / sender / target filter below still
      // applies, the result set is just bounded.
      try {
        const senderHistory = await getRecentMessages(senderWorkerId, now - DEFAULT_DEDUP_WINDOW_MS);
        const recent: RecentMessageForDedup[] = senderHistory
          .filter(
            (it) =>
              it.messageType === 'communicationLog' &&
              it.senderSessionId === senderWorkerId &&
              it.targetSessionId === targetId
          )
          .map((it) => {
            let text = '';
            try {
              const parsed = JSON.parse(it.content) as Array<{ text?: string }>;
              text = parsed
                .map((c) => c.text ?? '')
                .filter((t) => t)
                .join('\n');
            } catch {
              text = it.content;
            }
            return { message: text, timestampMs: Number(it.SK) };
          });
        if (shouldSuppressDuplicateMessage(message, recent, now, DEFAULT_DEDUP_WINDOW_MS)) {
          console.warn(
            `[agent-messaging] Suppressing near-duplicate message from ${senderWorkerId} to ${targetId} ` +
              `(likely resurrection re-emit; first 80 chars="${message.slice(0, 80).replace(/\s+/g, ' ')}")`
          );
          // Treat as a successful no-op so the caller does not retry / surface
          // a failure. The original message is already in the target history.
          result.sent.push(targetId);
          continue;
        }

        // Acknowledgement-specific EXACT-duplicate guard. Acks are short
        // ("了解です", "Got it") and therefore slip through the general
        // near-duplicate check above (which never dedups < MIN_DEDUP_LENGTH).
        // An auto-retrigger re-runs the turn and re-emits the SAME ack to the
        // SAME peer — the observed "agent keeps sending the same ack" symptom.
        // Suppress ONLY a normalised-identical ack to this same target within
        // the window (same 5-min window as the long-message path so a
        // backoff-delayed retrigger re-ack is still caught). Exact-match keeps
        // false positives near-zero: a genuinely different ack ("進めてください")
        // is a different string and still goes through. Gated on
        // `acknowledge === true` so non-ack short messages keep their existing
        // (non-deduped) behaviour and intentional short repeats survive.
        if (acknowledge && shouldSuppressDuplicateAck(message, recent, now, DEFAULT_DEDUP_WINDOW_MS)) {
          console.warn(
            `[agent-messaging] Suppressing duplicate ack from ${senderWorkerId} to ${targetId} ` +
              `(likely auto-retrigger re-ack; first 80 chars="${message.slice(0, 80).replace(/\s+/g, ' ')}")`
          );
          result.sent.push(targetId);
          continue;
        }
      } catch (dedupErr) {
        // Dedup is best-effort: never block a real send because the look-back
        // query failed. Fall through and deliver normally.
        console.error(`[agent-messaging] dedup look-back failed (delivering anyway):`, dedupErr);
      }

      // Sanitise the components that go into the inline `[Message from ... (...)]`
      // prefix. `senderName` is usually agent-controlled (resolved from session
      // metadata) and `senderWorkerId` is internally generated, but we apply
      // sanitisation as defence in depth: a future code path could feed an
      // attacker-influenced name through here, and the label lives inside the
      // LLM prompt envelope where a stray newline or `]` would allow prompt
      // injection (see `sanitizeSenderLabel` in prompt.ts).
      const safeSenderName = sanitizeSenderLabel(senderName) || 'agent';
      const safeSenderWorkerId = sanitizeSenderLabel(senderWorkerId) || 'unknown';
      const wrappedMessage = `[Message from ${safeSenderName} (${safeSenderWorkerId})]: ${message}`;
      // This item (messageType: 'agentMessage') is delivered to the TARGET agent's history and
      // will be fed into its LLM context. We wrap it with `renderAgentMessage` so the payload
      // includes the `<user_message>` envelope and the trailing `<command>` hint that prompts
      // the recipient to reply via `sendMessageToAgent`. Do NOT skip this wrapping — the
      // recipient LLM relies on the envelope.
      const content = [{ text: renderAgentMessage({ message: wrappedMessage, senderSessionId: senderWorkerId }) }];

      const targetName = await resolveAgentDisplayName(targetSession);

      const item: MessageItem = {
        PK: `message-${targetId}`,
        SK: String(now).padStart(15, '0'),
        content: JSON.stringify(content),
        role: 'user',
        tokenCount: 0,
        messageType: 'agentMessage',
        senderSessionId: senderWorkerId,
        senderAgentName: senderName,
        targetSessionId: targetId,
        targetAgentName: targetName,
        isAcknowledge: acknowledge,
      };

      await ddb.send(new PutCommand({ TableName, Item: item }));

      // Notify the parent session's webapp about the communication (for communication log)
      const parentSessionId = senderSession.parentSessionId || targetSession.parentSessionId;
      if (parentSessionId && parentSessionId !== senderWorkerId) {
        if (parentSessionId !== targetId) {
          // Persist the sibling-to-sibling communication in the parent session's history so
          // it survives page reload in the UI. This item is stored with `messageType:
          // 'communicationLog'` so it is excluded from `getConversationHistory` by default
          // and therefore does NOT flow into the parent's LLM context. The `role: 'user'`
          // field is kept for UI rendering parity with `agentMessage`; it has no LLM
          // semantics because communicationLog items are filtered out before LLM calls.
          //
          // Intentionally storing the RAW `message` here (no `renderAgentMessage` wrapping):
          // this payload is UI-only, so the `<user_message>` / `<command>` envelope that
          // guides the LLM to reply is unnecessary. The webapp's render pipeline
          // (`extractUserMessage` + `stripAgentMessagePrefix`) handles either shape, so both
          // this raw form and the wrapped agentMessage form render identically — see
          // agent-messaging.test.ts for the render-parity regression test.
          const parentItem: MessageItem = {
            PK: `message-${parentSessionId}`,
            SK: String(now + 1).padStart(15, '0'),
            content: JSON.stringify([{ text: message }]),
            role: 'user',
            tokenCount: 0,
            messageType: 'communicationLog',
            senderSessionId: senderWorkerId,
            senderAgentName: senderName,
            targetSessionId: targetId,
            targetAgentName: targetName,
            isAcknowledge: acknowledge,
          };
          await ddb.send(new PutCommand({ TableName, Item: parentItem }));
        }

        // Always send real-time webapp notification to the parent session
        await sendWebappEvent(parentSessionId, {
          type: 'agentMessage',
          senderSessionId: senderWorkerId,
          senderName,
          targetSessionId: targetId,
          targetName,
          message,
          acknowledge: acknowledge ?? false,
        });
      }

      // Persist a communicationLog entry to the SENDER's own message table so the
      // sender's webapp chat shows the outgoing message. Without this, sent messages
      // only appear in the receiver's chat (asymmetric persistence bug).
      const senderItem: MessageItem = {
        PK: `message-${senderWorkerId}`,
        SK: String(now + 2).padStart(15, '0'),
        content: JSON.stringify([{ text: message }]),
        role: 'user',
        tokenCount: 0,
        messageType: 'communicationLog',
        senderSessionId: senderWorkerId,
        senderAgentName: senderName,
        targetSessionId: targetId,
        targetAgentName: targetName,
        isAcknowledge: acknowledge,
      };
      await ddb.send(new PutCommand({ TableName, Item: senderItem }));

      await sendWebappEvent(senderWorkerId, {
        type: 'agentMessage',
        senderSessionId: senderWorkerId,
        senderName,
        targetSessionId: targetId,
        targetName,
        message,
        acknowledge: acknowledge ?? false,
      });

      // W-A1: Emit agentMessage to the TARGET so its webapp renders the bubble
      // in real time (previously only parent + sender got the event, making the
      // target rely solely on lastMessageUpdate → router.refresh).
      // Skip if the target already received the event via the parent notification
      // path above (targetId === parentSessionId and parent block fired).
      const targetAlreadyNotified =
        parentSessionId && parentSessionId !== senderWorkerId && targetId === parentSessionId;
      if (!targetAlreadyNotified) {
        await sendWebappEvent(targetId, {
          type: 'agentMessage',
          senderSessionId: senderWorkerId,
          senderName,
          targetSessionId: targetId,
          targetName,
          message,
          acknowledge: acknowledge ?? false,
        });
      }

      // Intentionally do NOT emit lastMessageUpdate or update the DDB
      // lastMessage/lastMessageAt for agent-to-agent messages (ack OR non-ack).
      //
      // The session list (SessionsList) sorts by `lastMessageAt ?? updatedAt`
      // desc and shows `lastMessage` as the preview. Those fields represent the
      // user-facing conversation: user→agent messages and agent→user replies /
      // progress reports (report-progress + sendSystemMessage with a messageSK).
      // Agent-to-agent chatter is internal coordination the user "doesn't care
      // about" (their words) — letting it bump lastMessageAt floats an idle
      // parent PM session to the top of the list on every sibling exchange and
      // overwrites the human-visible preview with internal agent text. So agent
      // messages are now treated exactly like acks: persisted + rendered in the
      // session-detail communicationLog and delivered in real time via the
      // agentMessage event above, but they never reorder or re-preview the list.
      //
      // Consistency note: the agentMessage bubble is delivered live via the
      // sendWebappEvent calls above. We drop the `lastMessageUpdate` self-recovery
      // signal for the same reason acks already omit it — a communicationLog
      // bubble is non-critical, and RefreshOnFocus recovers a dropped event on
      // the next focus. (See the ack rationale that previously lived here.)

      if (!acknowledge) {
        // Wake up the target worker to process the message
        const runtimeType = targetSession.runtimeType ?? 'agent-core';
        await getOrCreateWorkerInstance(targetId, runtimeType);
        await sendWorkerEvent(targetId, { type: 'onMessageReceived' });
      }

      result.sent.push(targetId);
    } catch (e) {
      console.error(`[agent-messaging] Error sending to ${targetId}:`, e);
      result.failed.push({ sessionId: targetId, reason: (e as Error).message });
    }
  }

  return result;
}
