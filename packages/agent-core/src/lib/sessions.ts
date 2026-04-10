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
import { deleteAllEventTriggers } from './event-triggers';
import { deleteUnreadByWorkerId } from './unread';

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
 * Get direct child sessions of a parent session
 * @param parentWorkerId Worker ID of the parent session
 * @returns Array of child SessionItems
 */
export const getChildSessions = async (parentWorkerId: string): Promise<SessionItem[]> => {
  const allSessions = await getSessions(0);
  return allSessions.filter((s) => s.parentSessionId === parentWorkerId);
};

/**
 * Get all descendant sessions (children, grandchildren, etc.) recursively
 * @param parentWorkerId Worker ID of the root parent session
 * @returns Array of all descendant SessionItems
 */
export const getDescendantSessions = async (parentWorkerId: string): Promise<SessionItem[]> => {
  const allSessions = await getAllSessionsIncludingChildren();
  const descendants: SessionItem[] = [];
  const collect = (parentId: string) => {
    const children = allSessions.filter((s) => s.parentSessionId === parentId);
    for (const child of children) {
      descendants.push(child);
      collect(child.workerId);
    }
  };
  collect(parentWorkerId);
  return descendants;
};

/**
 * Get all sessions including those with parentSessionId (no isHidden filter)
 */
export const getAllSessionsIncludingChildren = async (): Promise<SessionItem[]> => {
  const paginator = paginateQuery(
    { client: ddb },
    {
      TableName,
      IndexName: 'LSI1',
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'sessions' },
      ScanIndexForward: false,
    }
  );
  const items: SessionItem[] = [];
  for await (const page of paginator) {
    if (page.Items != null) {
      items.push(...(page.Items as SessionItem[]));
    }
  }
  return items;
};

/**
 * Delete a session and all related data (messages, metadata) from DynamoDB.
 * Also recursively deletes all descendant (child, grandchild, etc.) sessions.
 * @param workerId Worker ID of the session to delete
 */
export const deleteSession = async (workerId: string): Promise<void> => {
  // Recursively delete all descendant sessions first
  const descendants = await getDescendantSessions(workerId);
  for (const child of descendants) {
    await deleteSingleSession(child.workerId);
  }

  // Delete the session itself
  await deleteSingleSession(workerId);
};

/**
 * Delete a single session and its related data (without recursive child deletion)
 */
const deleteSingleSession = async (workerId: string): Promise<void> => {
  // Clean up all EventBridge triggers associated with this session
  try {
    await deleteAllEventTriggers(workerId);
  } catch (error) {
    console.error(`Error cleaning up event triggers for session ${workerId}:`, error);
  }

  // Delete the session record
  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: {
        PK: 'sessions',
        SK: workerId,
      },
    })
  );

  // Delete all related items (messages, metadata) in batches
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

    // BatchWrite supports max 25 items per request
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
  }

  // Delete all unread items for this session across all users
  try {
    await deleteUnreadByWorkerId(workerId);
  } catch (error) {
    console.error(`Error cleaning up unread items for session ${workerId}:`, error);
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
