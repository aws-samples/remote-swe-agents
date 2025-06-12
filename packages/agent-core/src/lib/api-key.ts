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
