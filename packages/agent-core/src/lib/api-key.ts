import { GetCommand, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import { ApiKeyItem } from '../schema';
import crypto from 'crypto';

/**
 * Create a new API key
 * @param description Optional description for the key
 * @param ownerId Optional owner ID
 * @returns The generated API key
 */
export const createApiKey = async (description?: string, ownerId?: string): Promise<string> => {
  const now = Date.now();
  const timestamp = String(now).padStart(15, '0');

  // Generate a random 32 byte key and hex encode it
  const apiKey = crypto.randomBytes(32).toString('hex');

  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: 'api-key',
        SK: apiKey,
        LSI1: timestamp,
        createdAt: now,
        description,
        ownerId,
      } satisfies ApiKeyItem,
    })
  );

  return apiKey;
};

/**
 * Validate if an API key exists
 * @param apiKey The API key to validate
 * @returns true if the key exists, false otherwise
 */
export const validateApiKey = async (apiKey: string): Promise<boolean> => {
  const result = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: 'api-key',
        SK: apiKey,
      },
    })
  );

  return !!result.Item;
};

/**
 * Stable, non-secret id for an API key. We never want to surface the raw
 * 64-char hex secret anywhere it might leak (LLM prompt envelopes, DDB
 * sender-id columns, broadcast events, UI tooltips), so we derive a short
 * SHA-256-prefix fingerprint of the key. The id is deterministic, so the
 * same API key always renders as the same sender across messages, but it
 * cannot be reversed back into the secret.
 *
 * Format: `apikey-<12-hex-chars>`. The fingerprint length is intentionally
 * generous (48 bits) so accidental collisions are astronomically unlikely
 * across the realistic key population (a few hundred keys per deployment).
 */
export const deriveApiKeyId = (apiKey: string): string => {
  const fingerprint = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
  return `apikey-${fingerprint}`;
};

/**
 * Resolve an API key to its identification info for sender attribution.
 * Returns `null` if the key does not exist (caller should reject the request
 * before reaching this function — `validateApiKey` is the auth check).
 *
 * `displayName` priority:
 *   1. the user-provided `description` (set when creating the key)
 *   2. the derived stable id (`apikey-xxxxxxxxxxxx`) so we never fall back
 *      to the raw secret.
 */
export const getApiKeySenderInfo = async (
  apiKey: string
): Promise<{ id: string; displayName: string; ownerId?: string } | null> => {
  const result = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: 'api-key',
        SK: apiKey,
      },
    })
  );

  if (!result.Item) return null;

  const item = result.Item as ApiKeyItem;
  const id = deriveApiKeyId(apiKey);
  const displayName = (item.description && item.description.trim()) || id;
  return {
    id,
    displayName,
    ownerId: item.ownerId,
  };
};

/**
 * Get the API keys owned by a user.
 *
 * API keys are bearer credentials, so a caller must only ever see the keys
 * they created themselves. Keys are stored in a single partition, so we page
 * through it and keep only the items whose `ownerId` matches. DynamoDB applies
 * `Limit` before `FilterExpression`, which is why the limit is enforced here
 * rather than passed to the query.
 *
 * @param ownerId The id of the user whose keys to return
 * @param limit Maximum number of keys to return
 * @returns Array of API key items owned by `ownerId`, newest first
 */
export const getApiKeys = async (ownerId: string, limit: number = 50): Promise<ApiKeyItem[]> => {
  if (!ownerId) {
    throw new Error('ownerId is required to list API keys');
  }

  const items: ApiKeyItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName,
        IndexName: 'LSI1',
        KeyConditionExpression: 'PK = :pk',
        FilterExpression: 'ownerId = :ownerId',
        ExpressionAttributeValues: {
          ':pk': 'api-key',
          ':ownerId': ownerId,
        },
        ScanIndexForward: false, // DESC order
        ExclusiveStartKey: exclusiveStartKey,
      })
    );

    items.push(...((res.Items ?? []) as ApiKeyItem[]));
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey && items.length < limit);

  return items.slice(0, limit);
};

/**
 * Delete an API key owned by a user.
 *
 * The delete is conditioned on `ownerId` matching, so a user cannot revoke
 * another user's key. A key that does not exist and a key owned by someone
 * else both fail the condition, so the caller cannot tell them apart.
 *
 * @param apiKey The API key to delete
 * @param ownerId The id of the user who must own the key
 * @throws Error if the key does not exist or is not owned by `ownerId`
 */
export const deleteApiKey = async (apiKey: string, ownerId: string): Promise<void> => {
  if (!ownerId) {
    throw new Error('ownerId is required to delete an API key');
  }

  try {
    await ddb.send(
      new DeleteCommand({
        TableName,
        Key: {
          PK: 'api-key',
          SK: apiKey,
        },
        ConditionExpression: 'ownerId = :ownerId',
        ExpressionAttributeValues: {
          ':ownerId': ownerId,
        },
      })
    );
  } catch (e) {
    if (e instanceof Error && e.name === 'ConditionalCheckFailedException') {
      throw new Error('API key not found');
    }
    throw e;
  }
};
