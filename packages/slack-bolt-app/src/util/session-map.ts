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

type SlackSessionOptions = {
  allowThreadFallback?: boolean;
};

export const getSessionIdFromSlack = async (
  channelId: string,
  threadTs: string,
  isThreadRoot: boolean,
  options: SlackSessionOptions = {}
) => {
  const workerId = threadTs.replace('.', '');
  if (isThreadRoot) {
    return { workerId, isNewSession: true };
  }

  const session = await getSession(workerId);
  if (session) {
    return { workerId, isNewSession: false };
  }

  const sessionMap = await getSessionMap(channelId, threadTs);
  if (sessionMap) {
    return { workerId: sessionMap.sessionId, isNewSession: false };
  }

  if (options.allowThreadFallback) {
    return { workerId, isNewSession: true };
  }

  throw new Error('No session was found for the thread!');
};
