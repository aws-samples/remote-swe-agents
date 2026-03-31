import {
  GetCommand,
  QueryCommand,
  QueryCommandInput,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
  paginateQuery,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ddb, TableName } from './aws';
import { AgentStatus, SessionItem, sessionItemSchema } from '../schema';

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

export const getSessions = async (
  limit: number = 50,
  range?: { startDate: number; endDate: number }
): Promise<SessionItem[]> => {
  const queryParams: QueryCommandInput = {
    TableName,
    IndexName: 'LSI1',
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': 'sessions',
    },
    ScanIndexForward: false, // DESC order
  };

  // Add date range filter if provided
  if (range) {
    const startTimestamp = String(range.startDate).padStart(15, '0');
    const endTimestamp = String(range.endDate).padStart(15, '0');

    queryParams.KeyConditionExpression += ' AND LSI1 BETWEEN :startDate AND :endDate';
    queryParams.ExpressionAttributeValues![':startDate'] = startTimestamp;
    queryParams.ExpressionAttributeValues![':endDate'] = endTimestamp;
  }

  // If limit is 0, fetch all results using pagination
  if (limit === 0) {
    const paginator = paginateQuery(
      {
        client: ddb,
      },
      queryParams
    );
    const items: SessionItem[] = [];
    for await (const page of paginator) {
      if (page.Items != null) {
        items.push(...(page.Items as SessionItem[]));
      }
    }
    return items.filter((session) => !session.isHidden);
  }

  // Otherwise, use the specified limit
  queryParams.Limit = limit;
  const res = await ddb.send(new QueryCommand(queryParams));

  const items = (res.Items ?? []) as SessionItem[];
  return items.filter((session) => !session.isHidden);
};

/**
 * Update agent status for a session
 * @param workerId Worker ID of the session to update
 * @param agentStatus New agent status
 */
export const updateSessionAgentStatus = async (workerId: string, agentStatus: AgentStatus): Promise<void> => {
  await updateSession(workerId, { agentStatus });
};

/**
 * Update isHidden field for a session
 * @param workerId Worker ID of the session to update
 * @param isHidden Whether the session should be hidden
 */
export const updateSessionVisibility = async (workerId: string, isHidden: boolean): Promise<void> => {
  await updateSession(workerId, { isHidden });
};

/**
 * Update title for a session
 * @param workerId Worker ID of the session to update
 * @param title The title to set for the session
 */
export const updateSessionTitle = async (workerId: string, title: string): Promise<void> => {
  await updateSession(workerId, { title });
};

/**
 * Update lastMessage for a session
 * @param workerId Worker ID of the session to update
 * @param lastMessage The latest message preview to set for the session
 */
export const updateSessionLastMessage = async (workerId: string, lastMessage: string): Promise<void> => {
  await updateSession(workerId, { lastMessage, lastMessageAt: Date.now() });
};

/**
 * Delete a session and all related data (messages, metadata) from DynamoDB
 * @param workerId Worker ID of the session to delete
 */
export const deleteSession = async (workerId: string): Promise<void> => {
  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: { PK: 'sessions', SK: workerId },
    })
  );

  const prefixes = [`message-${workerId}`, `metadata-${workerId}`];
  for (const prefix of prefixes) {
    const paginator = paginateQuery(
      { client: ddb },
      {
        TableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': prefix },
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
            [TableName]: batch.map((key) => ({ DeleteRequest: { Key: key } })),
          },
        })
      );
    }
  }
};

const keySchema = sessionItemSchema.pick({ PK: true, SK: true });

type UpdateSessionParams = Partial<Omit<SessionItem, 'PK' | 'SK' | 'createdAt'>>;

/**
 * Generic function to update session fields
 * @param workerId Worker ID of the session to update
 * @param params Object containing the fields to update
 */
export const updateSession = async (workerId: string, params: UpdateSessionParams): Promise<void> => {
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
        PK: 'sessions',
        SK: workerId,
      } satisfies z.infer<typeof keySchema>,
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );
};
