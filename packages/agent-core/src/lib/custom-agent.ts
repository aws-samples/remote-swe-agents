import { QueryCommand, PutCommand, UpdateCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { CustomAgent, EmptyMcpConfig, mcpConfigSchema } from '../schema';
import { ddb, TableName } from './aws';
import { randomBytes } from 'crypto';

const validateMcpConfig = (mcpConfig: string): void => {
  try {
    const parsedMcpConfig = JSON.parse(mcpConfig);
    mcpConfigSchema.parse(parsedMcpConfig);
  } catch (error) {
    throw new Error(`Invalid mcpConfig: ${error instanceof Error ? error.message : 'Invalid JSON or schema'}`);
  }
};

export const getCustomAgent = async (customAgentId: string | undefined): Promise<CustomAgent | undefined> => {
  if (!customAgentId) return undefined;
  const res = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: 'custom-agent',
        SK: customAgentId,
      },
    })
  );
  return res.Item as CustomAgent | undefined;
};

export const getCustomAgents = async (limit: number = 50): Promise<CustomAgent[]> => {
  const res = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': 'custom-agent',
      },
      ScanIndexForward: false, // DESC order
      Limit: limit,
    })
  );
  const agents = ((res.Items as CustomAgent[]) ?? []).map((agent) => ({
    ...agent,
    mcpConfig: JSON.stringify(JSON.parse(agent.mcpConfig), undefined, 2),
  })) satisfies CustomAgent[];

  return agents;
};

export const createCustomAgent = async (
  agent: Omit<CustomAgent, 'PK' | 'SK' | 'createdAt' | 'updatedAt'>
): Promise<CustomAgent> => {
  if (!agent.mcpConfig) {
    agent.mcpConfig = JSON.stringify(EmptyMcpConfig);
  }
  validateMcpConfig(agent.mcpConfig);

  const now = Date.now();
  const id = `${randomBytes(6).toString('base64url')}`;

  const customAgent: CustomAgent = {
    PK: 'custom-agent',
    SK: id,
    ...agent,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(
    new PutCommand({
      TableName,
      Item: customAgent,
    })
  );

  return customAgent;
};

/**
 * Partially update a custom agent. Only keys whose value is not `undefined` are
 * written; omitted or `undefined` fields keep their existing values in DynamoDB.
 * `inferenceMode` additionally accepts an explicit `null`, which REMOVEs the
 * attribute from the item (reset to "inherit from Preferences"). Other fields
 * intentionally do not accept `null` so required attributes cannot be removed
 * by accident.
 *
 * Behavior notes:
 * - `updatedAt` is always bumped, even when `updates` is an empty object.
 * - `mcpConfig` is validated only when explicitly provided. In particular,
 *   passing an empty string `""` will throw (previously it was silently
 *   replaced with the default `{"mcpServers":{}}`). Callers that want to
 *   reset mcpConfig must pass a valid JSON string such as `{"mcpServers":{}}`.
 * - The caller is expected to have validated the keys of `updates` (e.g. via
 *   a zod schema); this function does not apply an allowlist of its own.
 */
export const updateCustomAgent = async (
  sk: string,
  updates: Partial<Omit<CustomAgent, 'PK' | 'SK' | 'createdAt' | 'updatedAt' | 'inferenceMode'>> & {
    inferenceMode?: CustomAgent['inferenceMode'] | null;
  }
): Promise<CustomAgent> => {
  if (updates.mcpConfig != null) {
    validateMcpConfig(updates.mcpConfig);
  }

  const now = Date.now();

  const updateExpression = [];
  const removeExpression = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, string | number | boolean | string[]> = {};

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === null) {
      removeExpression.push(`#${key}`);
      expressionAttributeNames[`#${key}`] = key;
      continue;
    }
    updateExpression.push(`#${key} = :${key}`);
    expressionAttributeNames[`#${key}`] = key;
    expressionAttributeValues[`:${key}`] = value;
  }

  updateExpression.push('#updatedAt = :updatedAt');
  expressionAttributeNames['#updatedAt'] = 'updatedAt';
  expressionAttributeValues[':updatedAt'] = now;

  const result = await ddb.send(
    new UpdateCommand({
      TableName,
      Key: {
        PK: 'custom-agent',
        SK: sk,
      },
      UpdateExpression: [
        `SET ${updateExpression.join(', ')}`,
        ...(removeExpression.length > 0 ? [`REMOVE ${removeExpression.join(', ')}`] : []),
      ].join(' '),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes as CustomAgent;
};

export const deleteCustomAgent = async (sk: string): Promise<void> => {
  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: {
        PK: 'custom-agent',
        SK: sk,
      },
    })
  );
};
