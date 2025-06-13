import { validateApiKey } from '@remote-swe-agents/agent-core/lib';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Middleware to validate API key in headers
 * @param request The Next.js request object
 * @returns Response or undefined if validation passes
 */
export async function validateApiKeyMiddleware(request: NextRequest): Promise<NextResponse | undefined> {
  // Extract API key from x-api-key header
  const apiKey = request.headers.get('x-api-key');

  if (!apiKey) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
  }

  const isValid = await validateApiKey(apiKey);

  if (!isValid) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  // If we reach here, the API key is valid
  return undefined;
}
