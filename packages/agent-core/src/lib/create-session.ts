import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import { MessageItem, ModelType, RuntimeType, SessionItem, defaultAgentConfig } from '../schema';
import { getOrCreateWorkerInstance, updateInstanceStatus } from './worker-manager';
import { sendWorkerEvent } from './events';
import { getCustomAgent } from './custom-agent';
import { renderUserMessage, renderAgentMessage, renderSystemNotification } from './prompt';
import { postNewSlackThread } from './slack';
import { getWebappSessionUrl } from './webapp-origin';
import { getChildSessions, getSession } from './sessions';
import { resolveAgentDisplayName } from './agent-messaging';
import { randomBytes } from 'crypto';

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
  const content: any[] = [
    {
      text: parentSessionId
        ? renderAgentMessage({ message, senderSessionId: parentSessionId })
        : renderUserMessage({ message }),
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

  // Resolve parent agent name for child sessions
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
