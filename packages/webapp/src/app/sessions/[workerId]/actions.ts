'use server';

import {
  fetchTodoListSchema,
  sendMessageToAgentSchema,
  updateAgentStatusSchema,
  sendEventSchema,
  stopSessionSchema,
  markSessionReadSchema,
  searchSessionContentSchema,
  updateSessionModelSchema,
} from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import {
  getOrCreateWorkerInstance,
  renderUserMessage,
  getTodoList,
  getSession,
  stopWorkerInstance,
  markSessionRead as markSessionReadLib,
  getUnreadSummary,
  addSessionParticipant,
  notifyOtherParticipants,
  updateSessionLastMessage,
  searchSessionContent,
  updateSession,
} from '@remote-swe-agents/agent-core/lib';
import { sendWorkerEvent, updateSessionAgentStatus, sendWebappEvent } from '@remote-swe-agents/agent-core/lib';
import { MessageItem, ModelType, KiroModelId } from '@remote-swe-agents/agent-core/schema';

export const sendMessageToAgent = authActionClient
  .inputSchema(sendMessageToAgentSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { workerId, message, imageKeys = [], fileKeys = [], modelOverride, kiroModelOverride } = parsedInput;
    const session = await getSession(workerId);
    if (!session) {
      throw new Error('Session not found');
    }

    // Sync session-level model from the form's selector value on every send.
    // This closes flush-race windows and migrates legacy sessions in one pass.
    const isKiroSession = session.inferenceMode === 'kiro-cli';
    if (!isKiroSession && modelOverride && session.bedrockDefaultModel !== modelOverride) {
      await updateSession(workerId, { bedrockDefaultModel: modelOverride });
    }
    if (isKiroSession && kiroModelOverride && session.kiroDefaultModel !== kiroModelOverride) {
      await updateSession(workerId, { kiroDefaultModel: kiroModelOverride as KiroModelId });
    }

    const content = [];
    content.push({
      text: renderUserMessage({
        message,
        sender: { type: 'webapp', id: ctx.userId, displayName: ctx.displayName },
      }),
    });
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
      // Per-message model overrides are deprecated — model selection is now
      // session-level only (bedrockDefaultModel / kiroDefaultModel).
      // Legacy read-side fallbacks remain for pre-migration sessions.
      senderUserId: ctx.userId,
      ...(ctx.displayName ? { senderDisplayName: ctx.displayName } : {}),
      senderType: 'webapp',
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

    // Track this user as a session participant and notify other participants
    try {
      await addSessionParticipant(workerId, ctx.userId);
      const senderLabel = ctx.displayName || 'User';
      const sessionLabel = session.title || workerId;
      const title = senderLabel;
      const body = `${sessionLabel}\n${message.slice(0, 200)}`;
      await notifyOtherParticipants(workerId, ctx.userId, {
        title,
        body,
      });
    } catch (e) {
      console.error('[session-participants] Failed to track/notify participants:', e);
    }

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

export type { SearchHit as SearchResult } from '@remote-swe-agents/agent-core/lib';

export const searchSessionContentAction = authActionClient
  .inputSchema(searchSessionContentSchema)
  .action(async ({ parsedInput }) => {
    const { workerId, query } = parsedInput;
    const { results, totalSessions, timedOut } = await searchSessionContent({
      query,
      scope: 'tree',
      sessionId: workerId,
    });
    return { results, totalSessions, timedOut };
  });

export const updateSessionModel = authActionClient
  .inputSchema(updateSessionModelSchema)
  .action(async ({ parsedInput }) => {
    const { workerId, bedrockDefaultModel, kiroDefaultModel } = parsedInput;
    const session = await getSession(workerId);
    if (!session) {
      throw new Error('Session not found');
    }
    const updates: { bedrockDefaultModel?: ModelType; kiroDefaultModel?: KiroModelId } = {};
    if (bedrockDefaultModel) updates.bedrockDefaultModel = bedrockDefaultModel;
    if (kiroDefaultModel) updates.kiroDefaultModel = kiroDefaultModel;
    if (Object.keys(updates).length === 0) return { success: true };
    await updateSession(workerId, updates);
    return { success: true };
  });
