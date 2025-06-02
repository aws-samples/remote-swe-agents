'use server';

import { createNewWorkerSchema } from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { getOrCreateWorkerInstance, renderUserMessage } from '@remote-swe-agents/agent-core/lib';
import { sendWorkerEvent } from '@remote-swe-agents/agent-core/lib';

export const createNewWorker = authActionClient.schema(createNewWorkerSchema).action(async ({ parsedInput, ctx }) => {
  const workerId = `webapp-${Date.now()}`;
  const { message } = parsedInput;
  const now = Date.now();

  const content = [];
  content.push({ text: renderUserMessage({ message }) });

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
            },
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
            },
          },
        },
      ],
    })
  );

  // Start EC2 instance for the worker
  await getOrCreateWorkerInstance(
    workerId,
    '', // slackChannelId - empty string for webapp
    '' // slackThreadTs - empty string for webapp
  );

  // Send worker event to notify message received
  await sendWorkerEvent(workerId, { type: 'onMessageReceived' });

  return { workerId };
});
