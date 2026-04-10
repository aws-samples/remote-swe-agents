import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import { getSession } from './sessions';
import { sendWorkerEvent, sendWebappEvent } from './events';
import { getOrCreateWorkerInstance } from './worker-manager';
import { renderAgentMessage } from './prompt';
import { getCustomAgent } from './custom-agent';
import { getPreferences } from './preferences';
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

  const senderSession = await getSession(senderWorkerId);
  if (!senderSession) {
    return { sent: [], failed: targetSessionIds.map((id) => ({ sessionId: id, reason: 'Sender session not found' })) };
  }

  const senderName = await resolveAgentDisplayName(senderSession);
  const result: SendAgentMessageResult = { sent: [], failed: [] };

  for (const targetId of targetSessionIds) {
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
      const wrappedMessage = `[Message from ${senderName} (${senderWorkerId})]: ${message}`;
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
      if (parentSessionId && parentSessionId !== targetId) {
        // Persist the agent message in the parent session's history so it survives page reload
        const parentItem: MessageItem = {
          PK: `message-${parentSessionId}`,
          SK: String(now + 1).padStart(15, '0'),
          content: JSON.stringify([{ text: message }]),
          role: 'user',
          tokenCount: 0,
          messageType: 'agentMessage',
          senderSessionId: senderWorkerId,
          senderAgentName: senderName,
          targetSessionId: targetId,
          targetAgentName: targetName,
          isAcknowledge: acknowledge,
        };
        await ddb.send(new PutCommand({ TableName, Item: parentItem }));

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
