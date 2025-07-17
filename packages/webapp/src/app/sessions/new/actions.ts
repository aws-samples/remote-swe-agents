'use server';

import { createNewWorkerSchema } from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { getOrCreateWorkerInstance, renderUserMessage } from '@remote-swe-agents/agent-core/lib';
import { sendWorkerEvent } from '@remote-swe-agents/agent-core/lib';
import { MessageItem, SessionItem } from '@remote-swe-agents/agent-core/schema';

export const createNewWorker = authActionClient
  .inputSchema(createNewWorkerSchema)
  .action(async ({ message, imageKeys = [] }, { userId }) => {
    const workerId = `webapp-${Date.now()}`;
    const now = Date.now();

    const content = [];
    content.push({ text: renderUserMessage({ message }) });

    // Add image keys if present
    if (imageKeys && imageKeys.length > 0) {
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
    }

    // Create session and initial message in a single transaction
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName,
              Item: {
                // Session record
                PK: 'sessions',
                SK: workerId,
                workerId,
                initialMessage: message,
                createdAt: now,
                LSI1: String(now).padStart(15, '0'),
                instanceStatus: 'starting',
                sessionCost: 0,
                agentStatus: 'pending',
                initiator: `webapp#${userId}`,
              } satisfies SessionItem,
            },
          },
          {
            Put: {
              TableName,
              Item: {
                PK: `message-${workerId}`,
                SK: `${String(Date.now()).padStart(15, '0')}`,
                content: JSON.stringify(content),
                role: 'user',
                tokenCount: 0,
                messageType: 'userMessage',
              } satisfies MessageItem,
            },
          },
        ],
      })
    );

    // Start EC2 instance for the worker
    await getOrCreateWorkerInstance(workerId);

    // Send worker event to notify message received
    await sendWorkerEvent(workerId, { type: 'onMessageReceived' });

    return { workerId };
  });
