import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CustomAgent } from '../schema';
import { ddb, TableName } from './aws';

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

  return (res.Items ?? []) as CustomAgent[];
};

export const putCustomAgents = async () => {};
