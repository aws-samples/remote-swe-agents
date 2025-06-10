import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';

type SessionItem = {
  PK: string;
  SK: string;
  workerId: string;
  createdAt: number;
  LSI1: string;
  initialMessage: string;
  instanceStatus: 'starting' | 'running' | 'stopped' | 'terminated';
  sessionCost: number;
};

export const saveSessionInfo = async (workerId: string, initialMessage: string) => {
  const now = Date.now();
  const timestamp = String(now).padStart(15, '0');

  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: 'sessions',
        SK: workerId,
        workerId,
        createdAt: now,
        LSI1: timestamp,
        initialMessage,
        instanceStatus: 'terminated',
        sessionCost: 0,
      } satisfies SessionItem,
    })
  );
};

/**
 * Get session information from DynamoDB
 * @param workerId Worker ID to fetch session information for
 * @returns Session information including instance status
 */
export async function getSession(workerId: string): Promise<SessionItem | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: 'sessions',
        SK: workerId,
      },
    })
  );

  if (!result.Item) {
    return;
  }

  return result.Item as SessionItem;
}

export const getSessions = async (): Promise<SessionItem[]> => {
  const res = await ddb.send(
    new QueryCommand({
      TableName,
      IndexName: 'LSI1',
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': 'sessions',
      },
      ScanIndexForward: false, // DESC order
      Limit: 50,
    })
  );

  return (res.Items ?? []) as SessionItem[];
};
