import webpush from 'web-push';
import { QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { ddb, TableName } from './aws';
import { PushSubscriptionItem } from '../schema/push-subscription';
import { getUnreadSummary } from './unread';

const ssm = new SSMClient({});
let cachedVapidPublicKey: string | undefined | null = undefined;
let cachedVapidPrivateKey: string | undefined | null = undefined;

async function resolveVapidKey(envKey: string, paramNameEnvKey: string): Promise<string | undefined> {
  // Direct value takes priority
  const directValue = process.env[envKey];
  if (directValue) return directValue;

  // Try to fetch from SSM
  const paramName = process.env[paramNameEnvKey];
  if (!paramName) return undefined;

  try {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: paramName,
        WithDecryption: true,
      })
    );
    return result.Parameter?.Value ?? undefined;
  } catch (error) {
    console.error(`Failed to fetch SSM parameter ${paramName}:`, error);
    return undefined;
  }
}

export async function getVapidPublicKey(): Promise<string | undefined> {
  if (cachedVapidPublicKey !== undefined) return cachedVapidPublicKey ?? undefined;
  cachedVapidPublicKey = (await resolveVapidKey('VAPID_PUBLIC_KEY', 'VAPID_PUBLIC_KEY_PARAMETER_NAME')) ?? null;
  return cachedVapidPublicKey ?? undefined;
}

async function getVapidPrivateKey(): Promise<string | undefined> {
  if (cachedVapidPrivateKey !== undefined) return cachedVapidPrivateKey ?? undefined;
  cachedVapidPrivateKey = (await resolveVapidKey('VAPID_PRIVATE_KEY', 'VAPID_PRIVATE_KEY_PARAMETER_NAME')) ?? null;
  return cachedVapidPrivateKey ?? undefined;
}

export async function savePushSubscription(
  userId: string,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
): Promise<void> {
  const endpointHash = Buffer.from(subscription.endpoint).toString('base64url').slice(0, 128);
  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: `push-subscription-${userId}`,
        SK: endpointHash,
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        createdAt: Date.now(),
      } satisfies PushSubscriptionItem,
    })
  );
}

export async function deletePushSubscription(userId: string, endpoint: string): Promise<void> {
  const endpointHash = Buffer.from(endpoint).toString('base64url').slice(0, 128);
  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: {
        PK: `push-subscription-${userId}`,
        SK: endpointHash,
      },
    })
  );
}

async function getSubscriptionsForUser(userId: string): Promise<PushSubscriptionItem[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `push-subscription-${userId}`,
      },
    })
  );
  return (result.Items ?? []) as PushSubscriptionItem[];
}

export async function sendPushNotificationToUser(
  userId: string,
  payload: { title: string; body: string; url?: string; workerId?: string }
): Promise<void> {
  console.log(`[push-debug] sendPushNotificationToUser called for userId: ${userId}`);
  const vapidPublicKey = await getVapidPublicKey();
  const vapidPrivateKey = await getVapidPrivateKey();

  if (!vapidPublicKey || !vapidPrivateKey) {
    console.log('[push-debug] VAPID keys not configured, skipping push notification');
    return;
  }
  console.log(`[push-debug] VAPID keys loaded. publicKey: ${vapidPublicKey.slice(0, 10)}...`);

  webpush.setVapidDetails('mailto:noreply@example.com', vapidPublicKey, vapidPrivateKey);

  const subscriptions = await getSubscriptionsForUser(userId);
  console.log(`[push-debug] Found ${subscriptions.length} subscriptions for user ${userId}`);

  // Get unread summary for badge info
  const unreadSummary = await getUnreadSummary(userId);
  const enrichedPayload = {
    ...payload,
    badge: {
      pendingCount: unreadSummary.pendingCount,
      hasOtherUnread: unreadSummary.hasOtherUnread,
    },
  };

  for (const sub of subscriptions) {
    try {
      console.log(`[push-debug] Sending to endpoint: ${sub.endpoint.slice(0, 60)}...`);
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: sub.keys,
        },
        JSON.stringify(enrichedPayload)
      );
      console.log(`[push-debug] Sent successfully to ${sub.endpoint.slice(0, 60)}...`);
    } catch (error: any) {
      if (error?.statusCode === 410 || error?.statusCode === 404) {
        await deletePushSubscription(userId, sub.endpoint);
        console.log(`[push-debug] Removed expired push subscription for user ${userId}, status: ${error?.statusCode}`);
      } else {
        console.error(
          `[push-debug] Failed to send push notification to user ${userId}:`,
          error?.statusCode,
          error?.message
        );
      }
    }
  }
}
