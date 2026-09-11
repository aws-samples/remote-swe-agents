/**
 * Lambda@Edge origin-request handler for the preview CloudFront distribution.
 *
 * Authentication model: Token Handoff
 * - First visit: webapp issues a signed handoff token in the URL query
 * - L@E validates the token (HMAC-SHA256) and sets a session cookie
 * - Subsequent requests (assets, WS upgrades) use the session cookie
 *
 * Config is read from an SSM parameter at cold start (L@E has no env vars).
 * The handoff secret is fetched from Secrets Manager (with 5-min cache TTL to
 * survive rotation without downtime).
 */

import { CloudFrontRequestEvent, CloudFrontRequestResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

interface PreviewConfig {
  tableName: string;
  mainRegion: string;
  handoffSecretArn: string;
}

let cachedConfig: PreviewConfig | null = null;
let cachedHandoffSecret: { value: string; fetchedAt: number } | null = null;

const HANDOFF_SECRET_CACHE_TTL_MS = 5 * 60 * 1000; // 5-min TTL for rotation safety

const SSM_PARAMETER_NAME = process.env.__PREVIEW_CONFIG_PARAM__ || '/__PREVIEW_CONFIG_PARAM_PLACEHOLDER__';

const ssmClient = new SSMClient({ region: 'us-east-1' });

// SecretsManager client must target mainRegion (where the secret lives), not us-east-1
let secretsClient: SecretsManagerClient | null = null;

function getSecretsClient(region: string): SecretsManagerClient {
  if (!secretsClient) {
    secretsClient = new SecretsManagerClient({ region });
  }
  return secretsClient;
}

// should-fix 7: Module-scope DDB client (reused across requests)
let ddbClient: DynamoDBClient | null = null;

function getDdbClient(region: string): DynamoDBClient {
  if (!ddbClient) {
    ddbClient = new DynamoDBClient({ region });
  }
  return ddbClient;
}

async function getConfig(): Promise<PreviewConfig> {
  if (cachedConfig) return cachedConfig;

  const resp = await ssmClient.send(new GetParameterCommand({ Name: SSM_PARAMETER_NAME, WithDecryption: true }));
  if (!resp.Parameter?.Value) {
    throw new Error(`Preview config parameter ${SSM_PARAMETER_NAME} not found or empty`);
  }

  cachedConfig = JSON.parse(resp.Parameter.Value) as PreviewConfig;
  return cachedConfig;
}

// R-B: Fetch handoff secret from Secrets Manager with TTL cache
async function getHandoffSecret(secretArn: string, region: string): Promise<string> {
  if (cachedHandoffSecret && Date.now() - cachedHandoffSecret.fetchedAt < HANDOFF_SECRET_CACHE_TTL_MS) {
    return cachedHandoffSecret.value;
  }
  const client = getSecretsClient(region);
  const resp = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const value = resp.SecretString;
  if (!value) {
    throw new Error('Handoff secret is empty in Secrets Manager');
  }
  cachedHandoffSecret = { value, fetchedAt: Date.now() };
  return value;
}

const SESSION_COOKIE_NAME = '__preview_session';
const SESSION_COOKIE_MAX_AGE = 28800; // 8 hours (matches MicroVM max lifetime)

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// should-fix 2: Safe comparison that handles length mismatch without throwing
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function verifyHandoffToken(token: string, secret: string): { workerId: string; exp: number } | null {
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx < 0) return null;

  const payloadB64 = token.slice(0, dotIdx);
  const signature = token.slice(dotIdx + 1);

  const expectedSig = signPayload(payloadB64, secret);
  if (!safeCompare(signature, expectedSig)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (!payload.workerId || !payload.exp) return null;
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function generateSessionId(): string {
  return randomBytes(24).toString('hex');
}

function verifySessionCookie(
  cookieValue: string,
  secret: string
): { workerId: string; sid: string; exp: number } | null {
  const dotIdx = cookieValue.lastIndexOf('.');
  if (dotIdx < 0) return null;

  const payloadB64 = cookieValue.slice(0, dotIdx);
  const signature = cookieValue.slice(dotIdx + 1);

  const expectedSig = signPayload(payloadB64, secret);
  if (!safeCompare(signature, expectedSig)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (!payload.workerId || !payload.sid || !payload.exp) return null;
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function createSessionCookie(workerId: string, secret: string): string {
  const sid = generateSessionId();
  const exp = Math.floor(Date.now() / 1000) + SESSION_COOKIE_MAX_AGE;
  const payload = Buffer.from(JSON.stringify({ workerId, sid, exp })).toString('base64url');
  const sig = signPayload(payload, secret);
  return `${payload}.${sig}`;
}

function extractCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  for (const cookie of cookies) {
    if (cookie.startsWith(`${name}=`)) {
      return cookie.slice(name.length + 1);
    }
  }
  return null;
}

// Read a single query-string parameter value without mutating the raw query string.
// Returns the decoded value, '' for a bare (valueless) flag, or null if absent.
export function getQueryParam(querystring: string, name: string): string | null {
  if (!querystring) return null;
  for (const pair of querystring.split('&')) {
    if (pair === name) return '';
    if (pair.startsWith(`${name}=`)) {
      try {
        return decodeURIComponent(pair.slice(name.length + 1));
      } catch {
        return pair.slice(name.length + 1);
      }
    }
  }
  return null;
}

// Remove a single query-string parameter (value or bare flag, at any position)
// while preserving the exact original text, order, casing, and encoding of every
// other parameter. This intentionally avoids URLSearchParams, whose toString()
// appends '=' to valueless flags (e.g. `lang.css` -> `lang.css=`), which changes
// the URL suffix Vite relies on to detect direct CSS requests and corrupts the
// served content-type/body for Slidev/Vite `?...&lang.css` style modules.
export function removeQueryParam(querystring: string, name: string): string {
  if (!querystring) return '';
  const kept = querystring.split('&').filter((pair) => pair !== name && !pair.startsWith(`${name}=`));
  return kept.join('&');
}

export const handler = async (event: CloudFrontRequestEvent): Promise<CloudFrontRequestResult> => {
  const request = event.Records[0].cf.request;
  const uri = request.uri;

  let config: PreviewConfig;
  try {
    config = await getConfig();
  } catch (e) {
    console.error('Config load failed:', e);
    return { status: '503', statusDescription: 'Service Unavailable', body: 'Preview service configuration error.' };
  }

  let handoffSecret: string;
  try {
    handoffSecret = await getHandoffSecret(config.handoffSecretArn, config.mainRegion);
  } catch (e) {
    console.error('Secret fetch failed:', e);
    return { status: '503', statusDescription: 'Service Unavailable', body: 'Preview service secret error.' };
  }

  const cookieHeader = request.headers['cookie']?.[0]?.value;
  const sessionCookie = extractCookie(cookieHeader, SESSION_COOKIE_NAME);
  let cookieSession: { workerId: string; sid: string; exp: number } | null = null;
  if (sessionCookie) {
    cookieSession = verifySessionCookie(sessionCookie, handoffSecret);
  }

  const pathMatch = uri.match(/^\/([^/]+)(\/.*)?$/);
  const firstSegment = pathMatch?.[1] ?? null;
  const remainingPath = pathMatch?.[2] || '/';

  let workerId: string;
  let forwardPath: string;

  // Credential-first routing: check handoff token first, then cookie.
  // No regex-based workerId format detection — works with any ID format.
  const qs = request.querystring;
  const handoffToken = getQueryParam(qs, '__preview_token');

  if (handoffToken && firstSegment) {
    // Case 1: Handoff token present — validate and issue cookie
    const tokenPayload = verifyHandoffToken(handoffToken, handoffSecret);
    if (!tokenPayload || tokenPayload.workerId !== firstSegment) {
      return {
        status: '401',
        statusDescription: 'Unauthorized',
        body: 'Invalid or expired handoff token. Please request a new preview URL from the agent.',
      };
    }
    const cookieValue = createSessionCookie(firstSegment, handoffSecret);
    const cleanQs = removeQueryParam(qs, '__preview_token');
    const redirectPath = `/${firstSegment}${remainingPath}${cleanQs ? '?' + cleanQs : ''}`;
    const setCookieHeaders: Array<{ key: string; value: string }> = [
      {
        key: 'Set-Cookie',
        value: `${SESSION_COOKIE_NAME}=${cookieValue}; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Lax`,
      },
      {
        key: 'Set-Cookie',
        value: `${SESSION_COOKIE_NAME}=; Path=/${firstSegment}; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
      },
    ];
    // S2: Clear stale Path-scoped cookies from previous sessions
    if (cookieSession && cookieSession.workerId !== firstSegment) {
      setCookieHeaders.push({
        key: 'Set-Cookie',
        value: `${SESSION_COOKIE_NAME}=; Path=/${cookieSession.workerId}; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
      });
    }
    return {
      status: '302',
      statusDescription: 'Found',
      headers: {
        location: [{ key: 'Location', value: redirectPath }],
        'set-cookie': setCookieHeaders,
        'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      },
    };
  } else if (cookieSession && firstSegment && cookieSession.workerId === firstSegment) {
    // Case 2: Cookie matches first path segment → strip prefix
    workerId = firstSegment;
    forwardPath = remainingPath;
  } else if (cookieSession) {
    // Case 3: Cookie present but first segment doesn't match → asset path
    // Forward full URI as-is to the cookie's worker (handles /@vite/client, /assets/, /_next/, etc.)
    // Design constraint: only one preview active per browser tab at a time.
    workerId = cookieSession.workerId;
    forwardPath = uri;
  } else {
    // Case 4: No token, no cookie — cannot route
    return {
      status: '401',
      statusDescription: 'Unauthorized',
      body: 'Authentication required. Please open the preview link from the webapp.',
    };
  }

  // Authenticated — look up MicroVM endpoint and token from DDB
  const ddb = getDdbClient(config.mainRegion);

  let endpoint: string;
  let token: string;

  try {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: config.tableName,
        Key: {
          PK: { S: `preview-token-${workerId}` },
          SK: { S: 'current' },
        },
      })
    );

    if (!result.Item) {
      return { status: '404', statusDescription: 'Not Found', body: 'No active preview for this session.' };
    }

    endpoint = result.Item.endpoint?.S ?? '';
    token = result.Item.token?.S ?? '';

    if (!endpoint || !token) {
      return { status: '502', statusDescription: 'Bad Gateway', body: 'Preview configuration is incomplete.' };
    }
  } catch (e) {
    console.error('DDB lookup failed:', e);
    return { status: '502', statusDescription: 'Bad Gateway', body: 'Failed to look up preview configuration.' };
  }

  // Rewrite origin to MicroVM endpoint
  request.origin = {
    custom: {
      domainName: endpoint,
      port: 443,
      protocol: 'https',
      path: '',
      sslProtocols: ['TLSv1.2'],
      readTimeout: 60,
      keepaliveTimeout: 60,
      customHeaders: {
        'x-aws-proxy-auth': [{ key: 'X-aws-proxy-auth', value: token }],
        'x-aws-proxy-port': [{ key: 'X-aws-proxy-port', value: '8080' }],
      },
    },
  };

  request.headers['host'] = [{ key: 'Host', value: endpoint }];

  // Strip workerId prefix from the URI (forwardPath already computed above)
  request.uri = forwardPath;

  // Strip __preview_token from query string so it's not forwarded to dev server.
  // Use string-level removal (not URLSearchParams) to preserve the exact original
  // parameter order and encoding — critically, bare flags like `lang.css` must NOT
  // gain a trailing '=' or Vite mis-detects the request and returns a CSS body with
  // a text/javascript content-type, breaking module loading (white screen).
  if (request.querystring) {
    request.querystring = removeQueryParam(request.querystring, '__preview_token');
  }

  // Remove preview session cookie from forwarded request (don't leak to dev server)
  if (request.headers['cookie']) {
    const filteredCookies = cookieHeader!
      .split(';')
      .map((c) => c.trim())
      .filter((c) => !c.startsWith(`${SESSION_COOKIE_NAME}=`))
      .join('; ');
    if (filteredCookies) {
      request.headers['cookie'] = [{ key: 'Cookie', value: filteredCookies }];
    } else {
      delete request.headers['cookie'];
    }
  }

  return request;
};
