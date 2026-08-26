import { getApiKeySenderInfo, validateApiKey } from '@remote-swe-agents/agent-core/lib';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Identification info for an authenticated API-key request. Used by routes
 * that record the request as a "user message" so we can attribute the
 * message to the specific API key (rather than the generic "User") in both
 * the LLM prompt envelope and the webapp UI.
 */
export type ApiKeySenderInfo = {
  /** Stable, non-secret id derived from the key itself (`apikey-xxxxxxxxxxxx`). */
  id: string;
  /** Human-readable name (the key's `description`, or the derived id when blank). */
  displayName: string;
  /** Optional Cognito user id of the key's owner. */
  ownerId?: string;
};

/**
 * Result of API-key validation:
 *   - `{ ok: false, response }` when validation failed; the caller should
 *     return `response` immediately.
 *   - `{ ok: true, sender }` when validation succeeded; `sender` carries the
 *     key's stable id and human-readable name for attribution.
 */
export type ApiKeyAuthResult = { ok: false; response: NextResponse } | { ok: true; sender: ApiKeySenderInfo };

/**
 * Authenticate a request via the `x-api-key` header and return the key's
 * sender attribution info on success. Returns a `NextResponse` to bubble up
 * to the caller on failure.
 */
export async function authenticateApiKey(request: NextRequest): Promise<ApiKeyAuthResult> {
  // Extract API key from x-api-key header
  const apiKey = request.headers.get('x-api-key');

  if (!apiKey) {
    return { ok: false, response: NextResponse.json({ error: 'Missing API key' }, { status: 401 }) };
  }

  const sender = await getApiKeySenderInfo(apiKey);
  if (!sender) {
    return { ok: false, response: NextResponse.json({ error: 'Invalid API key' }, { status: 401 }) };
  }

  return { ok: true, sender };
}

/**
 * Backward-compatible middleware wrapper retained for routes that only need
 * a yes/no auth check and do not record sender attribution. New routes
 * SHOULD prefer `authenticateApiKey` so they can populate sender info on
 * any messages they persist.
 */
export async function validateApiKeyMiddleware(request: NextRequest): Promise<NextResponse | undefined> {
  const apiKey = request.headers.get('x-api-key');

  if (!apiKey) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
  }

  const isValid = await validateApiKey(apiKey);

  if (!isValid) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  return undefined;
}
