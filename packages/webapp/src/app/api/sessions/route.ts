import { validateApiKeyMiddleware } from '../auth/api-key';
import { NextRequest, NextResponse } from 'next/server';
import { createSession } from '@remote-swe-agents/agent-core/lib';
import { z } from 'zod';
import { modelTypeSchema } from '@remote-swe-agents/agent-core/schema';

// Schema for request validation
const createSessionSchema = z.object({
  message: z.string().min(1),
  modelOverride: modelTypeSchema.optional(),
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

  const workerId = await createSession({
    message,
    initiator: `rest#`,
  });

  return NextResponse.json({ sessionId: workerId }, { status: 201 });
}
