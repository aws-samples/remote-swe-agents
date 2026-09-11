import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { UserPreferences, userPreferencesSchema, updateUserPreferencesSchema } from '../schema';
import { ddb, TableName } from './aws';
import { z } from 'zod';

export const getUserPreferences = async (userId: string): Promise<UserPreferences> => {
  const res = await ddb.send(
    new GetCommand({
      TableName,
      Key: { PK: 'user-preferences', SK: userId },
    })
  );

  const item = res.Item ?? { PK: 'user-preferences', SK: userId };
  return userPreferencesSchema.parse(item);
};

export const updateUserPreferences = async (
  userId: string,
  params: z.infer<typeof updateUserPreferencesSchema>
): Promise<UserPreferences> => {
  const updateExpression: string[] = ['#updatedAt = :updatedAt'];
  const expressionAttributeNames: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const expressionAttributeValues: Record<string, unknown> = { ':updatedAt': Date.now() };

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      updateExpression.push(`#${key} = :${key}`);
      expressionAttributeNames[`#${key}`] = key;
      expressionAttributeValues[`:${key}`] = value;
    }
  }

  const res = await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { PK: 'user-preferences', SK: userId },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return userPreferencesSchema.parse(res.Attributes);
};
