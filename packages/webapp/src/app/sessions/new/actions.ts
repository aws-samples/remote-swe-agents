'use server';

import { createNewWorkerSchema } from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { getOrCreateWorkerInstance } from '@remote-swe-agents/agent-core/lib';
import { sendWorkerEvent } from '@remote-swe-agents/agent-core/aws';

export const createNewWorker = authActionClient.schema(createNewWorkerSchema).action(async ({ parsedInput, ctx }) => {
  const workerId = `webapp-${Date.now()}`;
  const { message } = parsedInput;
  const now = Date.now();

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
              // Initial message record
              PK: `message-${workerId}`,
              SK: String(now).padStart(15, '0'),
              content: JSON.stringify([{ text: message }]), // Slack app format
              role: 'user',
              tokenCount: 0,
              messageType: 'user',
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
  await sendWorkerEvent(workerId, 'onMessageReceived');

  return { workerId };
});
