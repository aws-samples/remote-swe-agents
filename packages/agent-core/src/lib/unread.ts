import { UpdateCommand, QueryCommand, GetCommand, BatchWriteCommand, paginateQuery } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import { UnreadItem } from '../schema/unread';

const pk = (userId: string) => `unread-${userId}`;

export const incrementUnread = async (
  userId: string,
  workerId: string,
  options?: { hasPending?: boolean }
): Promise<void> => {
  const updateExprParts = ['#unreadCount = if_not_exists(#unreadCount, :zero) + :one', '#updatedAt = :now'];
  const exprNames: Record<string, string> = {
    '#unreadCount': 'unreadCount',
    '#updatedAt': 'updatedAt',
  };
  const exprValues: Record<string, any> = {
    ':zero': 0,
    ':one': 1,
    ':now': Date.now(),
  };

  if (options?.hasPending) {
    updateExprParts.push('#hasPending = :true');
    exprNames['#hasPending'] = 'hasPending';
    exprValues[':true'] = true;
  }

  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { PK: pk(userId), SK: workerId },
      UpdateExpression: `SET ${updateExprParts.join(', ')}`,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    })
  );
};

export const markPending = async (userId: string, workerId: string): Promise<void> => {
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { PK: pk(userId), SK: workerId },
      UpdateExpression: 'SET #hasPending = :true, #updatedAt = :now, #unreadCount = if_not_exists(#unreadCount, :zero)',
      ExpressionAttributeNames: {
        '#hasPending': 'hasPending',
        '#updatedAt': 'updatedAt',
        '#unreadCount': 'unreadCount',
      },
      ExpressionAttributeValues: {
        ':true': true,
        ':now': Date.now(),
        ':zero': 0,
      },
    })
  );
};

export const markSessionRead = async (userId: string, workerId: string): Promise<void> => {
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { PK: pk(userId), SK: workerId },
      UpdateExpression: 'SET #unreadCount = :zero, #hasPending = :false, #lastReadAt = :now, #updatedAt = :now',
      ExpressionAttributeNames: {
        '#unreadCount': 'unreadCount',
        '#hasPending': 'hasPending',
        '#lastReadAt': 'lastReadAt',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':zero': 0,
        ':false': false,
        ':now': Date.now(),
      },
    })
  );
};

export const getLastReadAt = async (userId: string, workerId: string): Promise<number> => {
  const result = await ddb.send(
    new GetCommand({
      TableName,
      Key: { PK: pk(userId), SK: workerId },
    })
  );
  return (result.Item as UnreadItem | undefined)?.lastReadAt ?? 0;
};

export interface UnreadSummary {
  pendingCount: number;
  hasOtherUnread: boolean;
}

export const getUnreadSummary = async (userId: string): Promise<UnreadSummary> => {
  const items = await getUnreadItems(userId);
  let pendingCount = 0;
  let hasOtherUnread = false;

  for (const item of items) {
    if (item.hasPending) {
      pendingCount++;
    } else if (item.unreadCount > 0) {
      hasOtherUnread = true;
    }
  }

  return { pendingCount, hasOtherUnread };
};

export const getUnreadItems = async (userId: string): Promise<UnreadItem[]> => {
  const result = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': pk(userId),
      },
    })
  );

  return (result.Items ?? []) as UnreadItem[];
};

export interface UnreadSessionDetail {
  workerId: string;
  unreadCount: number;
  hasPending: boolean;
  updatedAt: number;
  title?: string;
  agentStatus?: string;
  instanceStatus?: string;
}

export const getUnreadSessionDetails = async (userId: string): Promise<UnreadSessionDetail[]> => {
  const items = await getUnreadItems(userId);
  const unreadItems = items.filter((item) => item.unreadCount > 0 || item.hasPending);

  if (unreadItems.length === 0) {
    return [];
  }

  // Batch fetch session details for all unread sessions
  const { getSession } = await import('./sessions');
  const details: UnreadSessionDetail[] = [];

  for (const item of unreadItems) {
    const session = await getSession(item.SK);
    details.push({
      workerId: item.SK,
      unreadCount: item.unreadCount,
      hasPending: item.hasPending,
      updatedAt: item.updatedAt,
      title: session?.title,
      agentStatus: session?.agentStatus,
      instanceStatus: session?.instanceStatus,
    });
  }

  // Sort by updatedAt descending (most recent first)
  details.sort((a, b) => b.updatedAt - a.updatedAt);

  return details;
};

export const markAllSessionsRead = async (userId: string): Promise<void> => {
  const items = await getUnreadItems(userId);
  const unreadItems = items.filter((item) => item.unreadCount > 0 || item.hasPending);

  for (const item of unreadItems) {
    await markSessionRead(userId, item.SK);
  }
};

export type UnreadMap = Record<string, { unreadCount: number; hasPending: boolean }>;

export const getUnreadMap = async (userId: string): Promise<UnreadMap> => {
  const items = await getUnreadItems(userId);
  const map: UnreadMap = {};
  for (const item of items) {
    map[item.SK] = { unreadCount: item.unreadCount, hasPending: item.hasPending };
  }
  return map;
};

/**
 * Delete all unread items for a given workerId across all users.
 * Uses GSI1 (SK → PK reverse lookup) to efficiently query by workerId
 * without a full table scan.
 */
export const deleteUnreadByWorkerId = async (workerId: string): Promise<void> => {
  const paginator = paginateQuery(
    { client: ddb },
    {
      TableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'SK = :sk AND begins_with(PK, :prefix)',
      ExpressionAttributeValues: {
        ':sk': workerId,
        ':prefix': 'unread-',
      },
      ProjectionExpression: 'PK, SK',
    }
  );

  const keysToDelete: { PK: string; SK: string }[] = [];
  for await (const page of paginator) {
    if (page.Items) {
      keysToDelete.push(...(page.Items as { PK: string; SK: string }[]));
    }
  }

  for (let i = 0; i < keysToDelete.length; i += 25) {
    const batch = keysToDelete.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [TableName]: batch.map((key) => ({
            DeleteRequest: { Key: key },
          })),
        },
      })
    );
  }
};
