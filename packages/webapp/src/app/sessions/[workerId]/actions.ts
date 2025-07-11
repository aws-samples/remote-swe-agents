'use server';

import { fetchTodoListSchema, sendMessageToAgentSchema, updateAgentStatusSchema, sendEventSchema } from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { getOrCreateWorkerInstance, renderUserMessage, getTodoList } from '@remote-swe-agents/agent-core/lib';
import { sendWorkerEvent, updateSessionAgentStatus } from '@remote-swe-agents/agent-core/lib';
import { MessageItem } from '@remote-swe-agents/agent-core/schema';

export const sendMessageToAgent = authActionClient
  .schema(sendMessageToAgentSchema)
  .action(async ({ parsedInput: { workerId, message, imageKeys = [] }, ctx }) => {
    const content = [];
    content.push({ text: renderUserMessage({ message }) });
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

    const item: MessageItem = {
      PK: `message-${workerId}`,
      SK: `${String(Date.now()).padStart(15, '0')}`,
      content: JSON.stringify(content),
      role: 'user',
      tokenCount: 0,
      messageType: 'userMessage',
    };

    await ddb.send(
      new PutCommand({
        TableName,
        Item: item,
      })
    );

    await sendWorkerEvent(workerId, { type: 'onMessageReceived' });

    await getOrCreateWorkerInstance(workerId);

    return { success: true, item };
  });

export const fetchLatestTodoList = authActionClient
  .schema(fetchTodoListSchema)
  .action(async ({ parsedInput: { workerId } }) => {
    const todoList = await getTodoList(workerId);
    return { todoList };
  });

export const updateAgentStatus = authActionClient
  .schema(updateAgentStatusSchema)
  .action(async ({ parsedInput: { workerId, status } }) => {
    await updateSessionAgentStatus(workerId, status);
  });

export const sendEventToAgent = authActionClient
  .schema(sendEventSchema)
  .action(async ({ parsedInput: { workerId, event } }) => {
    await sendWorkerEvent(workerId, event);
    return { success: true };
  });
