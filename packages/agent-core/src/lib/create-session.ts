import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import {
  InferenceMode,
  KiroModelId,
  MessageItem,
  ModelType,
  RuntimeType,
  SessionItem,
  defaultAgentConfig,
} from '../schema';
import { getOrCreateWorkerInstance, updateInstanceStatus } from './worker-manager';
import { sendWorkerEvent } from './events';
import { getCustomAgent } from './custom-agent';
import { renderUserMessage, renderAgentMessage, renderSystemNotification, sanitizeSenderLabel } from './prompt';
import { postNewSlackThread } from './slack';
import { getWebappSessionUrl } from './webapp-origin';
import { getChildSessions, getSession } from './sessions';
import { resolveAgentDisplayName } from './agent-messaging';
import { randomBytes } from 'crypto';
import { addSessionParticipant } from './session-participants';

export interface CreateSessionParams {
  message: string;
  initiator: string;
  customAgentId?: string;
  title?: string;
  agentName?: string;
  modelOverride?: ModelType;
  parentSessionId?: string;
  imageKeys?: string[];
  fileKeys?: string[];
  /**
   * If provided, a new Slack thread will be created in this channel
   * and linked to the new session.
   */
  slackChannelId?: string;
  /**
   * Slack user ID to mention in the new thread notification.
   */
  slackMentionUserId?: string;
  /**
   * Session ID that created this session (for independent sessions).
   * Unlike parentSessionId (which establishes parent-child hierarchy),
   * this simply records who created the session so it can send messages back.
   */
  creatorSessionId?: string;
  /**
   * Cognito user ID of the message sender (for per-user inference mode / API key lookup).
   */
  senderUserId?: string;
  /**
   * Origin of the user message: "slack" or "webapp". When set, it is both
   * persisted on the initial message item and embedded in the LLM prompt
   * envelope (`[from: ... (<type>)]\n`), matching the behaviour of subsequent
   * messages added via the webapp/Slack message actions. Only meaningful for
   * root (user-initiated) sessions — child sessions always use the
   * `[Message from <parent>...]` prefix instead.
   */
  senderType?: 'slack' | 'webapp';
  /**
   * Human-readable display name of the user who seeded this session. Used
   * alongside `senderType` for the `[from: <displayName> (<type>)]` envelope
   * header and persisted on the initial message item so the webapp UI can
   * render the sender.
   */
  senderDisplayName?: string;
  /**
   * Inference mode to bake into the session at creation time.
   * Once set, the session uses this backend for its entire lifetime regardless of
   * user/custom-agent preference changes. If omitted, the worker falls back to the
   * dynamic resolution chain (customAgent > userPreferences > env > default).
   */
  inferenceMode?: InferenceMode;
  /**
   * Model selection for kiro-cli mode. Only used when inferenceMode === 'kiro-cli'.
   */
  kiroModel?: string;
  /**
   * New symmetric Bedrock model field. Takes priority over legacy `defaultModel`.
   */
  bedrockDefaultModel?: ModelType;
  /**
   * New symmetric Kiro model field. Takes priority over legacy `kiroModel`.
   */
  kiroDefaultModel?: KiroModelId;
  /**
   * When true, the session row and seed message are persisted but the worker
   * is NOT started (no `getOrCreateWorkerInstance` / `onMessageReceived`).
   * The caller is responsible for booting the worker later. Used by the
   * webapp handover flow, which must finish re-parenting the old session
   * under the new one BEFORE the new worker reads its seed message (the seed
   * states the re-parenting has already happened).
   */
  deferWorkerStart?: boolean;
  /**
   * Source session ID whose full conversation history should be dumped to the
   * worker's local filesystem on first turn. Set during successor (handover)
   * session creation.
   */
  handoverSourceSessionId?: string;
}

/**
 * Create a new session with an initial message, start the worker, and send the event.
 * This is the shared logic used by webapp, REST API, and tools.
 * @returns The workerId of the newly created session
 */
export const createSession = async (params: CreateSessionParams): Promise<string> => {
  const {
    message,
    initiator,
    customAgentId,
    title,
    agentName,
    modelOverride,
    parentSessionId,
    imageKeys = [],
    fileKeys = [],
    slackChannelId,
    slackMentionUserId,
    creatorSessionId,
    senderUserId,
    senderType,
    senderDisplayName,
    inferenceMode,
    kiroModel,
    bedrockDefaultModel,
    kiroDefaultModel,
    deferWorkerStart,
    handoverSourceSessionId,
  } = params;
  const agent = await getCustomAgent(customAgentId);
  const runtimeType: RuntimeType = agent?.runtimeType ?? defaultAgentConfig.runtimeType;

  let workerId = `session-${Date.now()}`;
  if (runtimeType === 'agent-core') {
    const lacking = 33 - workerId.length;
    if (lacking > 0) {
      workerId = `${workerId}-${randomBytes(Math.ceil(lacking / 2)).toString('hex')}`;
    }
  }

  const now = Date.now();
  // Resolve parent agent name upfront so we can stamp the child's seed message
  // with the same `[Message from <name> (<sessionId>)]: ...` prefix that
  // subsequent inter-agent messages use (see `sendAgentMessage` in
  // agent-messaging.ts). Without this prefix, the very first message the child
  // receives is missing the sender attribution, while all following messages
  // have it — leading to confusing first-turn reasoning.
  let parentAgentName: string | undefined;
  if (parentSessionId) {
    try {
      const parentSession = await getSession(parentSessionId);
      if (parentSession) {
        parentAgentName = await resolveAgentDisplayName(parentSession);
      }
    } catch (e) {
      console.error('Failed to resolve parent agent name:', e);
    }
  }

  const content: any[] = [
    {
      text: parentSessionId
        ? renderAgentMessage({
            // Sanitise the sender label for the same reasons documented in
            // `sendAgentMessage` — `parentAgentName` is resolved from
            // session metadata today, but a future code path could seed that
            // field with attacker-controlled text, and a stray newline /
            // envelope character in the `[Message from ... (...)]:` prefix
            // would allow prompt injection inside the child's first turn.
            message: `[Message from ${sanitizeSenderLabel(parentAgentName ?? 'parent') || 'parent'} (${
              sanitizeSenderLabel(parentSessionId) || 'unknown'
            })]: ${message}`,
            senderSessionId: parentSessionId,
          })
        : renderUserMessage({
            message,
            // Mirror the per-message behaviour of the webapp/Slack send
            // actions: when the initial message carries sender info, embed
            // it in the LLM envelope as `[from: <displayName> (<type>)]`.
            // Without this, the very first turn of a session has no sender
            // attribution even though every following turn does — the LLM
            // then cannot tell who started the conversation.
            ...(senderType
              ? {
                  sender: {
                    type: senderType,
                    id: senderUserId ?? 'unknown',
                    displayName: senderDisplayName,
                  },
                }
              : {}),
          }),
    },
  ];
  for (const key of imageKeys) {
    content.push({
      image: {
        format: 'webp',
        source: {
          s3Key: key,
        },
      },
    });
  }
  for (const key of fileKeys) {
    const fileName = key.split('/').pop() || 'file';
    content.push({
      file: {
        source: {
          s3Key: key,
        },
        fileName,
      },
    });
  }

  let slackThreadTs: string | undefined;
  if (slackChannelId) {
    try {
      const sessionUrl = await getWebappSessionUrl(workerId);
      const mention = slackMentionUserId ? `<@${slackMentionUserId}> ` : '';
      const displayTitle = title ?? message.slice(0, 100);
      const webLink = sessionUrl ? ` (<${sessionUrl}|*Web UI*>)` : '';
      const threadMessage = `${mention}:thread: *New session started:* ${displayTitle}${webLink}`;
      slackThreadTs = await postNewSlackThread(slackChannelId, threadMessage);
    } catch (e) {
      console.error('Failed to create Slack thread for new session:', e);
    }
  }

  // parentAgentName was resolved earlier (before content rendering) so the
  // child's seed message carries the sender prefix. Reuse that value here.

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName,
            Item: {
              PK: 'sessions',
              SK: workerId,
              workerId,
              initialMessage: message,
              createdAt: now,
              updatedAt: now,
              LSI1: String(now).padStart(15, '0'),
              instanceStatus: 'starting',
              sessionCost: 0,
              agentStatus: 'pending',
              initiator,
              customAgentId: agent?.SK,
              runtimeType,
              ...(title ? { title } : {}),
              ...(agentName ? { agentName } : {}),
              ...(parentSessionId ? { parentSessionId } : {}),
              ...(creatorSessionId ? { creatorSessionId } : {}),
              ...(slackChannelId ? { slackChannelId } : {}),
              ...(slackThreadTs ? { slackThreadTs } : {}),
              ...(inferenceMode ? { inferenceMode } : {}),
              ...(inferenceMode === 'kiro-cli' && kiroModel ? { kiroModel } : {}),
              ...(bedrockDefaultModel ? { bedrockDefaultModel } : {}),
              ...(kiroDefaultModel ? { kiroDefaultModel } : {}),
              ...(handoverSourceSessionId ? { handoverSourceSessionId } : {}),
            } satisfies SessionItem,
          },
        },
        {
          Put: {
            TableName,
            Item: {
              PK: `message-${workerId}`,
              SK: `${String(now).padStart(15, '0')}`,
              content: JSON.stringify(content),
              role: 'user',
              tokenCount: 0,
              messageType: parentSessionId ? 'agentMessage' : 'userMessage',
              ...(modelOverride ? { modelOverride } : {}),
              ...(parentSessionId ? { senderSessionId: parentSessionId } : {}),
              ...(parentAgentName ? { senderAgentName: parentAgentName } : {}),
              ...(senderUserId ? { senderUserId } : {}),
              // Persist the human sender attributes on root (user-seeded)
              // sessions so the webapp UI can render "<displayName>" on the
              // first bubble — matching the second-and-later-message path
              // served by the webapp/Slack send actions.
              ...(!parentSessionId && senderDisplayName ? { senderDisplayName } : {}),
              ...(!parentSessionId && senderType ? { senderType } : {}),
            } satisfies MessageItem,
          },
        },
      ],
    })
  );

  try {
    // Track the session creator as a participant (webapp users only)
    if (senderUserId && !parentSessionId) {
      try {
        await addSessionParticipant(workerId, senderUserId);
      } catch (e) {
        console.error('Failed to add session creator as participant:', e);
      }
    }

    if (!deferWorkerStart) {
      await getOrCreateWorkerInstance(workerId, runtimeType);
      await sendWorkerEvent(workerId, { type: 'onMessageReceived' });
    }
  } catch (e) {
    await updateInstanceStatus(workerId, 'terminated');
    throw e;
  }

  // Notify existing sibling sessions about the new child
  if (parentSessionId) {
    try {
      const siblings = await getChildSessions(parentSessionId);
      const displayName = agentName || title || workerId;
      for (const sibling of siblings) {
        if (sibling.workerId === workerId) continue;
        const notifyContent = [
          {
            text: renderSystemNotification({
              message: `A new sibling session has joined: "${displayName}" (ID: ${workerId}). You can communicate with it using sendMessageToAgent.`,
            }),
          },
        ];
        const notifyItem: MessageItem = {
          PK: `message-${sibling.workerId}`,
          SK: String(Date.now()).padStart(15, '0'),
          content: JSON.stringify(notifyContent),
          role: 'user',
          tokenCount: 0,
          messageType: 'eventTrigger',
        };
        await ddb.send(new PutCommand({ TableName, Item: notifyItem }));
        await sendWorkerEvent(sibling.workerId, { type: 'onMessageReceived' });
      }
    } catch (e) {
      console.error('Failed to notify sibling sessions:', e);
    }
  }

  return workerId;
};
