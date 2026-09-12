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
 * Get all API keys
 * @param limit Maximum number of keys to return
 * @returns Array of API key items
 */
export const getApiKeys = async (limit: number = 50): Promise<ApiKeyItem[]> => {
  const res = await ddb.send(
    new QueryCommand({
      TableName,
      IndexName: 'LSI1',
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': 'api-key',
      },
      ScanIndexForward: false, // DESC order
      Limit: limit,
    })
  );

  return (res.Items ?? []) as ApiKeyItem[];
};

/**
 * Delete an API key
 * @param apiKey The API key to delete
 */
export const deleteApiKey = async (apiKey: string): Promise<void> => {
  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: {
        PK: 'api-key',
        SK: apiKey,
      },
    })
  );
};
