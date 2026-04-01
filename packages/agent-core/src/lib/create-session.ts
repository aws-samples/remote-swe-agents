import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import { MessageItem, ModelType, RuntimeType, SessionItem, defaultRuntimeType } from '../schema';
import { getOrCreateWorkerInstance, updateInstanceStatus } from './worker-manager';
import { sendWorkerEvent } from './events';
import { getCustomAgent } from './custom-agent';
import { renderUserMessage } from './prompt';
import { postNewSlackThread } from './slack';
import { getWebappSessionUrl } from './webapp-origin';
import { randomBytes } from 'crypto';

export interface CreateSessionParams {
  message: string;
  initiator: string;
  customAgentId?: string;
  title?: string;
  modelOverride?: ModelType;
  /**
   * If provided, a new Slack thread will be created in this channel
   * and linked to the new session.
   */
  slackChannelId?: string;
  /**
   * Slack user ID to mention in the new thread notification.
   */
  slackMentionUserId?: string;
}

/**
 * Create a new session with an initial message, start the worker, and send the event.
 * This is the shared logic used by webapp, REST API, and tools.
 * @returns The workerId of the newly created session
 */
export const createSession = async (params: CreateSessionParams): Promise<string> => {
  const { message, initiator, customAgentId, title, modelOverride, slackChannelId, slackMentionUserId } = params;
  const agent = await getCustomAgent(customAgentId);
  const runtimeType: RuntimeType = agent?.runtimeType ?? defaultRuntimeType;

  let workerId = `session-${Date.now()}`;
  if (runtimeType === 'agent-core') {
    const lacking = 33 - workerId.length;
    if (lacking > 0) {
      workerId = `${workerId}-${randomBytes(Math.ceil(lacking / 2)).toString('hex')}`;
    }
  }

  const now = Date.now();
  const content = [{ text: renderUserMessage({ message }) }];

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
              ...(slackChannelId ? { slackChannelId } : {}),
              ...(slackThreadTs ? { slackThreadTs } : {}),
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
              messageType: 'userMessage',
              ...(modelOverride ? { modelOverride } : {}),
            } satisfies MessageItem,
          },
        },
      ],
    })
  );

  try {
    await getOrCreateWorkerInstance(workerId, runtimeType);
    await sendWorkerEvent(workerId, { type: 'onMessageReceived' });
  } catch (e) {
    await updateInstanceStatus(workerId, 'terminated');
    throw e;
  }

  return workerId;
};
