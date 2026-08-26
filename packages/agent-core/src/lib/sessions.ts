import {
  GetCommand,
  QueryCommand,
  QueryCommandInput,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
  paginateQuery,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ddb, TableName, batchWriteWithRetry } from './aws';
import { AgentStatus, SessionItem, sessionItemSchema } from '../schema';
import { deleteAllEventTriggers } from './event-triggers';
import { deleteUnreadByWorkerId } from './unread';
import { sendWebappEvent } from './events';

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
    return items;
  }

  // Otherwise, use the specified limit
  queryParams.Limit = limit;
  const res = await ddb.send(new QueryCommand(queryParams));

  const items = (res.Items ?? []) as SessionItem[];
  return items;
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
 * Persist the ACP session ID issued by kiro-cli.
 * Called once after a new ACP session is created so subsequent turns can resume via session/load.
 * @param workerId Worker ID of the session
 * @param kiroSessionId The ACP session ID returned by kiro-cli
 */
export const updateSessionKiroSessionId = async (workerId: string, kiroSessionId: string): Promise<void> => {
  await updateSession(workerId, { kiroSessionId });
};

/**
 * Remove the persisted kiroSessionId so the next turn creates a fresh session.
 * Used for self-healing when session/load fails (D5: stale-ID recovery).
 */
export const clearSessionKiroSessionId = async (workerId: string): Promise<void> => {
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { PK: 'sessions', SK: workerId } satisfies z.infer<typeof keySchema>,
      UpdateExpression: 'REMOVE #kiroSessionId SET #updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#kiroSessionId': 'kiroSessionId', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':updatedAt': Date.now() },
    })
  );
};

/**
 * Atomically claim a session handover by recording the successor's worker ID.
 *
 * The conditional write is the single serialisation point of the webapp
 * handover flow: it succeeds at most once per session (and only while the
 * session is not completed), so concurrent or repeated handover attempts
 * cannot each spawn their own successor. Callers should catch
 * `ConditionalCheckFailedException` and re-read the session — if
 * `handedOverTo` is set, converge on that existing successor.
 *
 * @param workerId Worker ID of the session being handed over
 * @param successorWorkerId Worker ID of the successor session
 */
export const markSessionHandedOver = async (workerId: string, successorWorkerId: string): Promise<void> => {
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { PK: 'sessions', SK: workerId },
      ConditionExpression:
        'attribute_exists(SK) AND attribute_not_exists(#handedOverTo) AND #agentStatus <> :completed',
      UpdateExpression: 'SET #handedOverTo = :successor, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#handedOverTo': 'handedOverTo',
        '#agentStatus': 'agentStatus',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':successor': successorWorkerId,
        ':completed': 'completed',
        ':updatedAt': Date.now(),
      },
    })
  );
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
 * Atomically re-parent one or more sessions under a new parent session.
 * Used by the "parent handover" flow: a fresh root parent P' is created, then
 * the former parent P and its existing children are all moved under P'.
 *
 * Guards (minimal by design):
 *  - self-parent: a session cannot become its own parent.
 *  - cycle: the new parent must not already be a descendant of any session
 *    being re-parented (which would make a session its own ancestor). A
 *    visited-set bounds the ancestor walk so a pre-existing corrupt cycle
 *    cannot loop forever.
 *
 * All updates are applied in a single TransactWrite so the hierarchy never
 * ends up partially re-parented. TransactWrite supports up to 100 items.
 * @param newParentId Worker ID of the new parent session
 * @param childWorkerIds Worker IDs to re-parent under newParentId
 */
export const reparentSessions = async (newParentId: string, childWorkerIds: string[]): Promise<void> => {
  if (childWorkerIds.length === 0) return;

  if (childWorkerIds.length > 100) {
    throw new Error(
      `Cannot reparent more than 100 sessions in a single transaction (got ${childWorkerIds.length}); TransactWrite supports at most 100 items.`
    );
  }

  const childIdSet = new Set(childWorkerIds);
  if (childIdSet.has(newParentId)) {
    throw new Error(`Cannot set session ${newParentId} as its own parent`);
  }

  // Walk the new parent's ancestor chain. If any session being re-parented is
  // already an ancestor of the new parent, the move would create a cycle.
  const visited = new Set<string>([newParentId]);
  let cursor = (await getSession(newParentId))?.parentSessionId;
  while (cursor && !visited.has(cursor)) {
    if (childIdSet.has(cursor)) {
      throw new Error(`Reparenting would create a cycle: ${cursor} is an ancestor of ${newParentId}`);
    }
    visited.add(cursor);
    cursor = (await getSession(cursor))?.parentSessionId;
  }

  const now = Date.now();
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: childWorkerIds.map((childId) => ({
        Update: {
          TableName,
          Key: { PK: 'sessions', SK: childId },
          ConditionExpression: 'attribute_exists(SK)',
          UpdateExpression: 'SET #parentSessionId = :parentSessionId, #updatedAt = :updatedAt',
          ExpressionAttributeNames: { '#parentSessionId': 'parentSessionId', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':parentSessionId': newParentId, ':updatedAt': now },
        },
      })),
    })
  );

  // Notify webapp of hierarchy change so the sidebar can update in real time.
  for (const childId of childWorkerIds) {
    try {
      await sendWebappEvent(childId, {
        type: 'sessionReparented',
        newParentSessionId: newParentId,
        oldParentSessionId: null,
      });
    } catch {
      // Non-critical: webapp event failure does not affect the reparent
    }
  }
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
 * Get all sessions including those with parentSessionId
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
      await batchWriteWithRetry(
        batch.map((key) => ({
          DeleteRequest: { Key: key },
        }))
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

/**
 * Non-destructive rewind: set the session's rewindState so that messages after
 * cutoffSK are hidden from both the UI and the agent's LLM context. No messages
 * are deleted — the operation is fully reversible via `undoRewind`.
 *
 * For kiro-cli sessions, also clears `kiroSessionId` so the next turn creates a
 * fresh ACP session built from the (now shorter) visible history, using the
 * existing "no kiroSessionId → session/new" path in kiro-agent-loop.
 *
 * @param workerId Worker ID of the session
 * @param cutoffSK The SK of the last message that should remain visible
 */
export const rewindSession = async (workerId: string, cutoffSK: string): Promise<void> => {
  const now = Date.now();
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { PK: 'sessions', SK: workerId },
      UpdateExpression: 'SET #rewindState = :rewindState, #updatedAt = :updatedAt REMOVE #kiroSessionId',
      ExpressionAttributeNames: {
        '#rewindState': 'rewindState',
        '#updatedAt': 'updatedAt',
        '#kiroSessionId': 'kiroSessionId',
      },
      ExpressionAttributeValues: {
        ':rewindState': { cutoffSK, rewindedAt: now },
        ':updatedAt': now,
      },
    })
  );
};

/**
 * Undo a rewind: remove the rewindState from the session, making all messages
 * visible again. This is the inverse of `rewindSession`.
 *
 * Does NOT restore kiroSessionId — the next kiro turn will synthesize from the
 * full (now unfiltered) history, which is correct because the ACP session was
 * invalidated by the rewind and any post-rewind turns may have diverged.
 *
 * @param workerId Worker ID of the session
 */
export const undoRewind = async (workerId: string): Promise<void> => {
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { PK: 'sessions', SK: workerId },
      UpdateExpression: 'REMOVE #rewindState SET #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#rewindState': 'rewindState',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':updatedAt': Date.now(),
      },
    })
  );
};
