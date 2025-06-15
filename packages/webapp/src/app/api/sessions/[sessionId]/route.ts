import { validateApiKeyMiddleware } from '../../auth/api-key';
import { NextRequest, NextResponse } from 'next/server';
import {
  getSession,
  sendWebappEvent,
  sendWorkerEvent,
  getConversationHistory,
  noOpFiltering,
} from '@remote-swe-agents/agent-core/lib';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { formatMessage } from '@/lib/message-formatter';

// Schema for request validation
const sendMessageSchema = z.object({
  message: z.string().min(1),
});

interface RouteParams {
  params: Promise<{
    sessionId: string;
  }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  // Validate API key
  const apiKeyValidation = await validateApiKeyMiddleware(request);
  if (apiKeyValidation) {
    return apiKeyValidation;
  }

  // Get session ID from the URL params
  const { sessionId } = await params;

  // Parse and validate request body
  const body = await request.json();
  const parsedBody = sendMessageSchema.safeParse(body);

  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid request data', details: parsedBody.error.format() }, { status: 400 });
  }

  const { message } = parsedBody.data;

  // Check if session exists
  const session = await getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Create content for the message
  const content = [{ text: message }];

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
      },
    })
  );

  // Send worker event to notify message received
  await sendWorkerEvent(sessionId, { type: 'onMessageReceived' });
  await sendWebappEvent(sessionId, { type: 'message', role: 'user', message });

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
        const extracted = text
          .slice(text.indexOf('<user_message>') + '<user_message>'.length, text.indexOf('</user_message>'))
          .trim();

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
