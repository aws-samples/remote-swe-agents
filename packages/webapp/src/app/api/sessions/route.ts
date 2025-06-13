import { validateApiKeyMiddleware } from '../auth/api-key';
import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateWorkerInstance, renderUserMessage, sendWorkerEvent } from '@remote-swe-agents/agent-core/lib';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { MessageItem, SessionItem } from '@remote-swe-agents/agent-core/schema';

// Schema for request validation
const createSessionSchema = z.object({
  message: z.string().min(1),
});

export async function POST(request: NextRequest) {
  // Validate API key
  const apiKeyValidation = await validateApiKeyMiddleware(request);
  if (apiKeyValidation) {
    return apiKeyValidation;
  }

  // Parse and validate request body
  const body = await request.json();
  const parsedBody = createSessionSchema.safeParse(body);

  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid request data', details: parsedBody.error.format() }, { status: 400 });
  }

  const { message } = parsedBody.data;
  const workerId = `api-${Date.now()}`;
  const now = Date.now();

  // Create content for the message
  const content = [{ text: renderUserMessage({ message }) }];

  // Create session and initial message in a transaction
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
              agentStatus: 'pending',
              sessionCost: 0,
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
    '', // slackChannelId - empty for API
    '' // slackThreadTs - empty for API
  );

  // Send worker event to notify message received
  await sendWorkerEvent(workerId, { type: 'onMessageReceived' });

  return NextResponse.json({ sessionId: workerId }, { status: 201 });
}
