import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { fetchAuthSession } from 'aws-amplify/auth/server';
import { runWithAmplifyServerContext } from '@/lib/amplifyServerUtils';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createHmac } from 'node:crypto';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const HANDOFF_TOKEN_EXPIRY_SEC = 300;
const secretsClient = new SecretsManagerClient({});

let cachedSecret: { value: string; fetchedAt: number } | null = null;
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

async function getHandoffSecret(): Promise<string> {
  const arn = process.env.PREVIEW_HANDOFF_SECRET_ARN;
  if (!arn) throw new Error('PREVIEW_HANDOFF_SECRET_ARN not configured');
  if (cachedSecret && Date.now() - cachedSecret.fetchedAt < SECRET_CACHE_TTL_MS) {
    return cachedSecret.value;
  }
  const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!resp.SecretString) throw new Error('Handoff secret empty');
  cachedSecret = { value: resp.SecretString, fetchedAt: Date.now() };
  return cachedSecret.value;
}

async function isSessionParticipant(workerId: string, userId: string): Promise<boolean> {
  const result = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: `session-participants-${workerId}`,
        SK: userId,
      },
    })
  );
  return result.Item != null;
}

async function hasAnyParticipants(workerId: string): Promise<boolean> {
  const result = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `session-participants-${workerId}`,
      },
      Limit: 1,
    })
  );
  return (result.Items?.length ?? 0) > 0;
}

const HANDOFF_PREFIX = '/api/preview/handoff/';

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!path || path.length === 0) {
    return new NextResponse('Missing workerId in path', { status: 400 });
  }

  const workerId = path[0];

  const session = await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: (contextSpec) => fetchAuthSession(contextSpec),
  });

  if (!session.tokens?.accessToken || !session.userSub) {
    return new NextResponse('Unauthorized. Please sign in to access previews.', { status: 401 });
  }

  const userId = session.userSub;
  const hasParticipants = await hasAnyParticipants(workerId);
  if (hasParticipants) {
    const isParticipant = await isSessionParticipant(workerId, userId);
    if (!isParticipant) {
      return new NextResponse('Forbidden. You do not have access to this preview.', { status: 403 });
    }
  }

  const domain = process.env.PREVIEW_CLOUDFRONT_DOMAIN;
  if (!domain) {
    return new NextResponse('Preview not configured', { status: 503 });
  }

  try {
    const secret = await getHandoffSecret();
    const exp = Math.floor(Date.now() / 1000) + HANDOFF_TOKEN_EXPIRY_SEC;
    const payload = Buffer.from(JSON.stringify({ workerId, exp })).toString('base64url');
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    const token = `${payload}.${sig}`;

    const rawPathname = request.nextUrl.pathname;
    const prefixEnd = rawPathname.indexOf(HANDOFF_PREFIX) + HANDOFF_PREFIX.length;
    const afterPrefix = rawPathname.slice(prefixEnd);
    const slashIdx = afterPrefix.indexOf('/');
    const subPath = slashIdx >= 0 ? afterPrefix.slice(slashIdx) : '/';

    const originalSearch = request.nextUrl.search;
    const separator = originalSearch ? `${originalSearch}&` : '?';
    const url = `https://${domain}/${workerId}${subPath}${separator}__preview_token=${encodeURIComponent(token)}`;

    return NextResponse.redirect(url, 302);
  } catch (e: unknown) {
    console.error('Failed to generate handoff URL:', e);
    return new NextResponse('Internal error generating preview access', { status: 500 });
  }
}
