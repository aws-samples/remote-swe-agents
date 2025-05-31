'use server';

import { sendMessageToAgentSchema } from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { sendWorkerEvent } from '@remote-swe-agents/agent-core/lib';
import { getOrCreateWorkerInstance, renderUserMessage } from '@remote-swe-agents/agent-core/lib';

export const sendMessageToAgent = authActionClient
  .schema(sendMessageToAgentSchema)
  .action(async ({ parsedInput: { workerId, message, imageKeys = [] }, ctx }) => {
    const { userId } = ctx;

    const content = [];
    if (message) {
      content.push({ text: renderUserMessage({ message }) });
    }
    imageKeys.forEach((key) => {
      content.push({
        image: {
          format: 'webp',
          source: {
            s3Key: key,
          },
        },
      });
    });

    await ddb.send(
      new PutCommand({
        TableName,
        Item: {
          PK: `message-${workerId}`,
          SK: `${String(Date.now()).padStart(15, '0')}`,
          content: JSON.stringify(content),
          role: 'user',
          tokenCount: 0,
          messageType: 'userMessage',
          slackUserId: userId,
        },
      })
    );

    await sendWorkerEvent(workerId, { type: 'onMessageReceived' });

    await getOrCreateWorkerInstance(workerId, '', '');

    return { success: true };
  });
