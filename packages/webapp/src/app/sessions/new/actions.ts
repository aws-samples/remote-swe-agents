'use server';

import { createNewWorkerSchema } from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';

export const createNewWorker = authActionClient.schema(createNewWorkerSchema).action(async ({ parsedInput, ctx }) => {
  const workerId = `webapp-${Date.now()}`;
  const { message } = parsedInput;

  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: 'sessions',
        SK: workerId,
        workerId,
        initialMessage: message,
        createdAt: Date.now(),
        LSI1: String(Date.now()).padStart(15, '0'),
      },
    })
  );

  return { workerId };
});
