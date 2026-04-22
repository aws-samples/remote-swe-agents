import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { getSession } from '@remote-swe-agents/agent-core/lib';
import { z } from 'zod';

/**
 * When taking over a session, this item is created and associate a slack thread (threadTs)
 * with a sessionId.
 */
const sessionMapSchema = z.object({
  PK: z.literal('session-map'),
  /**
   * key of the session map
   */
  SK: z.string(),
  sessionId: z.string(),
});

export type SessionMap = z.infer<typeof sessionMapSchema>;

const getSessionMap = async (channelId: string, threadTs: string) => {
  const result = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: 'session-map',
        SK: `slack-${channelId}-${threadTs}`,
      },
    })
  );

  if (!result.Item) {
    return;
  }

  return result.Item as SessionMap;
};

export const getSessionIdFromSlack = async (channelId: string, threadTs: string, isThreadRoot: boolean) => {
  const rawWorkerId = threadTs.replace('.', '');
  // AgentCore runtimeSessionId requires at least 33 characters
  const paddedWorkerId = rawWorkerId.length < 33 ? rawWorkerId.padEnd(33, '0') : rawWorkerId;

  if (isThreadRoot) return paddedWorkerId;

  // Fall back to raw (unpadded) workerId for sessions created before padding was introduced
  const session = (await getSession(paddedWorkerId)) ?? (await getSession(rawWorkerId));
  if (session) return session.workerId;

  const sessionMap = await getSessionMap(channelId, threadTs);
  if (!sessionMap) {
    throw new Error('No session was found for the thread!');
  }

  return sessionMap.sessionId;
};
