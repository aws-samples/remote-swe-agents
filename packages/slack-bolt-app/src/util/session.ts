import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { RuntimeType, SessionItem } from '@remote-swe-agents/agent-core/schema';

export const saveSessionInfo = async (
  workerId: string,
  initialMessage: string,
  initiatorSlackUserId: string,
  slackChannelId: string,
  slackThreadTs: string,
  runtimeType?: RuntimeType
) => {
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
        updatedAt: now,
        LSI1: timestamp,
        initialMessage,
        instanceStatus: 'terminated',
        sessionCost: 0,
        agentStatus: 'pending',
        initiator: `slack#${initiatorSlackUserId}`,
        slackChannelId,
        slackThreadTs,
        ...(runtimeType ? { runtimeType } : {}),
      } satisfies SessionItem,
    })
  );
};
