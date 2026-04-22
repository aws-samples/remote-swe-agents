'use server';

import { fetchTodoListSchema, sendMessageToAgentSchema, updateAgentStatusSchema, sendEventSchema } from './schemas';
import { z } from 'zod';
import {
  fetchTodoListSchema,
  sendMessageToAgentSchema,
  updateAgentStatusSchema,
  sendEventSchema,
  stopSessionSchema,
  markSessionReadSchema,
} from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import {
  getOrCreateWorkerInstance,
  renderUserMessage,
  getTodoList,
  getSession,
  updateInstanceStatus,
  stopWorkerInstance,
  markSessionRead as markSessionReadLib,
  getUnreadSummary,
  updateSessionLastMessage,
} from '@remote-swe-agents/agent-core/lib';
import { sendWorkerEvent, updateSessionAgentStatus, sendWebappEvent } from '@remote-swe-agents/agent-core/lib';
import { MessageItem } from '@remote-swe-agents/agent-core/schema';

export const sendMessageToAgent = authActionClient
  .inputSchema(sendMessageToAgentSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { workerId, message, imageKeys = [], fileKeys = [], modelOverride } = parsedInput;
    const session = await getSession(workerId);
    if (!session) {
      throw new Error('Session not found');
    }

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
    fileKeys.forEach((key) => {
      const fileName = key.split('/').pop() || 'file';
      content.push({
        file: {
          source: {
            s3Key: key,
          },
          fileName,
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
      modelOverride,
    };

    await ddb.send(
      new PutCommand({
        TableName,
        Item: item,
      })
    );

    const lastMessagePreview = message.slice(0, 500);
    await updateSessionLastMessage(workerId, lastMessagePreview);
    await sendWebappEvent(workerId, {
      type: 'lastMessageUpdate',
      lastMessage: lastMessagePreview,
      lastMessageAt: Date.now(),
    });

    await sendWorkerEvent(workerId, { type: 'onMessageReceived' });

    await getOrCreateWorkerInstance(workerId, session.runtimeType ?? 'ec2');

    return { success: true, item };
  });

export const fetchLatestTodoList = authActionClient.inputSchema(fetchTodoListSchema).action(async ({ parsedInput }) => {
  const { workerId } = parsedInput;
  const todoList = await getTodoList(workerId);
  return { todoList };
});

export const updateAgentStatus = authActionClient
  .inputSchema(updateAgentStatusSchema)
  .action(async ({ parsedInput }) => {
    const { workerId, status } = parsedInput;
    await updateSessionAgentStatus(workerId, status);

    // Auto-stop the worker when marking as completed
    if (status === 'completed') {
      const session = await getSession(workerId);
      if (session) {
        await stopWorkerInstance(workerId, session.runtimeType ?? 'ec2');
      }
    }

    return { success: true };
  });

export const sendEventToAgent = authActionClient.inputSchema(sendEventSchema).action(async ({ parsedInput }) => {
  const { workerId, event } = parsedInput;
  await sendWorkerEvent(workerId, event);
  return { success: true };
});

const endSessionSchema = z.object({
  workerId: z.string(),
});

export const endSessionAction = authActionClient.inputSchema(endSessionSchema).action(async ({ parsedInput }) => {
  const { workerId } = parsedInput;
  await updateInstanceStatus(workerId, 'terminated');
  if (process.env.WORKER_TERMINATE_ON_SESSION_END === 'true') {
    await sendWorkerEvent(workerId, { type: 'requestTerminate' });
  }
  return { success: true };
});
export const stopSession = authActionClient.inputSchema(stopSessionSchema).action(async ({ parsedInput }) => {
  const { workerId } = parsedInput;
  const session = await getSession(workerId);
  if (!session) {
    throw new Error('Session not found');
  }
  await stopWorkerInstance(workerId, session.runtimeType ?? 'ec2');
  return { success: true };
});

export const markSessionReadAction = authActionClient
  .inputSchema(markSessionReadSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { workerId } = parsedInput;
    await markSessionReadLib(ctx.userId, workerId);
    const summary = await getUnreadSummary(ctx.userId);
    return { success: true, badge: summary };
  });
