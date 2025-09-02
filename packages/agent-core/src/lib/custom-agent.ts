import { QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CustomAgent, mcpConfigSchema } from '../schema';
import { ddb, TableName } from './aws';
import { randomBytes } from 'crypto';
import z from 'zod';

const validateMcpConfig = (mcpConfig: string): void => {
  try {
    const parsedMcpConfig = JSON.parse(mcpConfig);
    mcpConfigSchema.parse(parsedMcpConfig);
  } catch (error) {
    throw new Error(`Invalid mcpConfig: ${error instanceof Error ? error.message : 'Invalid JSON or schema'}`);
  }
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
    agent.mcpConfig = JSON.stringify({ mcpServers: {} } satisfies z.infer<typeof mcpConfigSchema>);
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

export const updateCustomAgent = async (
  sk: string,
  updates: Omit<CustomAgent, 'PK' | 'SK' | 'createdAt' | 'updatedAt'>
): Promise<CustomAgent> => {
  if (!updates.mcpConfig) {
    updates.mcpConfig = JSON.stringify({ mcpServers: {} } satisfies z.infer<typeof mcpConfigSchema>);
  }
  validateMcpConfig(updates.mcpConfig);

  const now = Date.now();

  const updateExpression = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, string | number | string[]> = {};

  for (const [key, value] of Object.entries(updates)) {
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
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes as CustomAgent;
};
