import { validateApiKeyMiddleware } from '../../auth/api-key';
import { NextRequest, NextResponse } from 'next/server';
import { getSession, renderUserMessage, sendWebappEvent, sendWorkerEvent } from '@remote-swe-agents/agent-core/lib';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';

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
  const content = [{ text: renderUserMessage({ message }) }];

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
