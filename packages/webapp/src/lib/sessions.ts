import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';

export type SessionInfo = {
  workerId: string;
  instanceStatus?: 'starting' | 'running' | 'sleeping' | 'terminated';
  createdAt?: number;
};

/**
 * Get session information from DynamoDB
 * @param workerId Worker ID to fetch session information for
 * @returns Session information including instance status
 */
export async function getSession(workerId: string): Promise<SessionInfo> {
  try {
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
      return { workerId };
    }

    return {
      workerId: result.Item.workerId,
      instanceStatus: result.Item.instanceStatus || 'terminated',
      createdAt: result.Item.createdAt,
    };
  } catch (error) {
    console.error('Error fetching session:', error);
    return { workerId };
  }
}
