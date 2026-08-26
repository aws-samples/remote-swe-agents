import { authenticateApiKey, validateApiKeyMiddleware } from '../../auth/api-key';
import { NextRequest, NextResponse } from 'next/server';
import {
  getSession,
  sendWebappEvent,
  sendWorkerEvent,
  getConversationHistory,
  noOpFiltering,
  getOrCreateWorkerInstance,
  renderUserMessage,
  notifyOtherParticipants,
  addSessionParticipant,
} from '@remote-swe-agents/agent-core/lib';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { extractUserMessage, formatMessage } from '@/lib/message-formatter';
import { MessageItem, modelTypeSchema } from '@remote-swe-agents/agent-core/schema';

// Schema for request validation
const sendMessageSchema = z.object({
  message: z.string().min(1),
  modelOverride: modelTypeSchema.optional(),
});

interface RouteParams {
  params: Promise<{
    sessionId: string;
  }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  // Validate API key and resolve sender attribution. We use
  // `authenticateApiKey` (not the boolean-only `validateApiKeyMiddleware`)
  // here so we can persist `senderType: 'apikey'`, the key's stable id
  // (`apikey-xxxxxxxxxxxx`) and its human-readable description on the
  // resulting message item. Without this, REST API messages would render
  // as the generic "User" in the webapp and as a header-less envelope to
  // the LLM, breaking sender disambiguation in mixed-source sessions.
  const auth = await authenticateApiKey(request);
  if (!auth.ok) {
    return auth.response;
  }
  const { sender } = auth;

  // Get session ID from the URL params
  const { sessionId } = await params;

  // Parse and validate request body
  const body = await request.json();
  const parsedBody = sendMessageSchema.safeParse(body);

  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid request data', details: parsedBody.error.format() }, { status: 400 });
  }

  const { message, modelOverride } = parsedBody.data;

  // Check if session exists
  const session = await getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Wrap with the LLM-side `[from: ... (apikey)]` envelope so the recipient
  // model can attribute the message correctly when multiple sources (Slack,
  // webapp, API) contribute to the same session.
  const content = [
    {
      text: renderUserMessage({
        message,
        sender: { type: 'apikey', id: sender.id, displayName: sender.displayName },
      }),
    },
  ];

  // Save the message
  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: `message-${sessionId}`,
        SK: `${String(Date.now()).padStart(15, '0')}`,
        content: JSON.stringify(content),
        role: 'user',
        tokenCount: 0,
        messageType: 'userMessage',
        modelOverride,
        // Persist sender attribution so the webapp UI can render the API
        // key's name on the bubble and so subsequent reads round-trip
        // identically through `page.tsx` and `MessageList` grouping.
        senderType: 'apikey',
        senderUserId: sender.id,
        senderDisplayName: sender.displayName,
      } satisfies MessageItem,
    })
  );

  // Start EC2 instance for the worker
  await getOrCreateWorkerInstance(sessionId);

  // Send worker event to notify message received
  await sendWorkerEvent(sessionId, { type: 'onMessageReceived' });
  await sendWebappEvent(sessionId, {
    type: 'message',
    role: 'user',
    message,
    senderUserId: sender.id,
    senderDisplayName: sender.displayName,
    senderType: 'apikey',
  });

  // Notify other session participants about this new message
  try {
    const participantUserId = sender.ownerId ?? sender.id;
    // Only register as participant when ownerId is known (a real Cognito user).
    // Legacy API keys without ownerId would pollute the participant list with
    // 'apikey-xxx' IDs that accumulate unread counts nobody ever reads.
    if (sender.ownerId) {
      await addSessionParticipant(sessionId, sender.ownerId);
    }
    const senderLabel = sender.displayName || 'API';
    const sessionLabel = session.title || sessionId;
    await notifyOtherParticipants(sessionId, participantUserId, {
      title: senderLabel,
      body: `${sessionLabel}\n${message.slice(0, 200)}`,
    });
  } catch (e) {
    console.error('[session-participants] Failed to notify participants from API route:', e);
  }

  return NextResponse.json({ success: true }, { status: 200 });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  // Validate API key
  const apiKeyValidation = await validateApiKeyMiddleware(request);
  if (apiKeyValidation) {
    return apiKeyValidation;
  }

  // Get session ID from the URL params
  const { sessionId } = await params;

  // Check if session exists
  const session = await getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Get conversation history
  const { items: historyItems } = await getConversationHistory(sessionId);
  const { messages: filteredMessages, items: filteredItems } = await noOpFiltering(historyItems);

  // Process messages similar to page.tsx
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const isMsg = (toolName: string | undefined) =>
    ['sendMessageToUser', 'sendMessageToUserIfNecessary'].includes(toolName ?? '');

  for (let i = 0; i < filteredMessages.length; i++) {
    const message = filteredMessages[i];
    const item = filteredItems[i];

    switch (item.messageType) {
      case 'toolUse': {
        const msgBlocks = message.content?.filter((block) => isMsg(block.toolUse?.name)) ?? [];

        if (msgBlocks.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let messageText = msgBlocks.map((b) => (b.toolUse?.input as any)?.message ?? '').join('\n');
          messageText = formatMessage(messageText);
          if (messageText) {
            messages.push({
              role: 'assistant',
              content: messageText,
            });
          }
        }
        break;
      }
      case 'userMessage': {
        const text = (message.content?.map((c) => c.text).filter((c) => c) ?? []).join('\n');
        const extracted = extractUserMessage(text);

        messages.push({
          role: 'user',
          content: extracted,
        });
        break;
      }
      case 'assistant': {
        const text = (message.content?.map((c) => c.text).filter((c) => c) ?? []).join('\n');
        const formatted = formatMessage(text);
        if (formatted) {
          messages.push({
            role: 'assistant',
            content: text,
          });
        }
        break;
      }
    }
  }

  const response = {
    agentStatus: session.agentStatus,
    instanceStatus: session.instanceStatus,
    sessionCost: parseFloat(session.sessionCost.toFixed(4)),
    messages,
  };

  return NextResponse.json(response, { status: 200 });
}
