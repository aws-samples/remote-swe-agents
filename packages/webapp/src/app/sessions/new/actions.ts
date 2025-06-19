'use server';

import { createNewWorkerSchema, promptTemplateSchema, updatePromptTemplateSchema, deletePromptTemplateSchema } from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { TransactWriteCommand, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { getOrCreateWorkerInstance, renderUserMessage } from '@remote-swe-agents/agent-core/lib';
import { sendWorkerEvent } from '@remote-swe-agents/agent-core/lib';
import { MessageItem, SessionItem } from '@remote-swe-agents/agent-core/schema';

export const createNewWorker = authActionClient.schema(createNewWorkerSchema).action(async ({ parsedInput, ctx }) => {
  const workerId = `webapp-${Date.now()}`;
  const { message, imageKeys = [] } = parsedInput;
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
  await getOrCreateWorkerInstance(
    workerId,
    '', // slackChannelId - empty string for webapp
    '' // slackThreadTs - empty string for webapp
  );

  // Send worker event to notify message received
  await sendWorkerEvent(workerId, { type: 'onMessageReceived' });

  return { workerId };
});

export const createPromptTemplateAction = authActionClient.schema(promptTemplateSchema).action(async ({ parsedInput, ctx }) => {
  const { title, content } = parsedInput;
  const now = Date.now();
  
  // テンプレートをDynamoDBに保存
  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: 'prompt-template',
        SK: String(now),
        title,
        content,
        createdAt: now,
        userId: ctx.userId,
      },
    })
  );
  
  return { success: true };
});

export const updatePromptTemplateAction = authActionClient.schema(updatePromptTemplateSchema).action(async ({ parsedInput, ctx }) => {
  const { id, title, content } = parsedInput;
  
  // テンプレートを更新
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: {
        PK: 'prompt-template',
        SK: id,
      },
      UpdateExpression: 'SET title = :title, content = :content',
      ExpressionAttributeValues: {
        ':title': title,
        ':content': content,
      },
    })
  );
  
  return { success: true };
});

export const deletePromptTemplateAction = authActionClient.schema(deletePromptTemplateSchema).action(async ({ parsedInput }) => {
  const { id } = parsedInput;
  
  // テンプレートを削除
  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: {
        PK: 'prompt-template',
        SK: id,
      },
    })
  );
  
  return { success: true };
});
