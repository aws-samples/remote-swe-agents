import { z } from 'zod';
import { GlobalPreference, globalPreferenceSchema, updateGlobalPreferenceSchema } from '../schema';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';

const keySchema = globalPreferenceSchema.pick({ PK: true, SK: true });

export const updatePreferences = async (params: z.infer<typeof updateGlobalPreferenceSchema>) => {
  const updateExpression: string[] = ['#updatedAt = :updatedAt'];
  const expressionAttributeNames: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const expressionAttributeValues: Record<string, any> = { ':updatedAt': Date.now() };

  Object.keys(params).forEach((key) => {
    if (params[key as keyof typeof params] !== undefined) {
      updateExpression.push(`#${key} = :${key}`);
      expressionAttributeNames[`#${key}`] = key;
      expressionAttributeValues[`:${key}`] = params[key as keyof typeof params];
    }
  });

  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: {
        PK: 'global-config',
        SK: 'general',
      } satisfies z.infer<typeof keySchema>,
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );
};

export const getPreferences = async (): Promise<GlobalPreference> => {
  const res = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: 'global-config',
        SK: 'general',
      } satisfies z.infer<typeof keySchema>,
    })
  );

  return globalPreferenceSchema.parse(res.Item);
};
