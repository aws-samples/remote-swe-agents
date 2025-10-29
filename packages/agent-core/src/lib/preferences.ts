import { z } from 'zod';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GlobalPreferences, globalPreferencesSchema, updateGlobalPreferenceSchema } from '../schema';
import { ddb, TableName } from './aws';

const keySchema = globalPreferencesSchema.pick({ PK: true, SK: true });

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

  const res = await ddb.send(
    new UpdateCommand({
      TableName,
      Key: {
        PK: 'global-config',
        SK: 'general',
      } satisfies z.infer<typeof keySchema>,
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    })
  );
  return globalPreferencesSchema.parse(res.Attributes);
};

export const getPreferences = async (): Promise<GlobalPreferences> => {
  const res = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: 'global-config',
        SK: 'general',
      } satisfies z.infer<typeof keySchema>,
    })
  );

  const item =
    res.Item ??
    ({
      PK: 'global-config',
      SK: 'general',
    } satisfies z.infer<typeof keySchema>);

  return globalPreferencesSchema.parse(item);
};
