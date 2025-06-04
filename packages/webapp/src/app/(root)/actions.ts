'use server';

import { authActionClient } from '@/lib/safe-action';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { z } from 'zod';

export const getSessions = authActionClient.schema(z.object({})).action(async ({ ctx }) => {
  const res = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': 'sessions',
      },
      ScanIndexForward: false, // 新しい順
      Limit: 50,
    })
  );

  const sessions = (res.Items || []).map((item) => ({
    workerId: item.workerId,
    createdAt: item.createdAt,
    title: `セッション ${item.workerId}`, // TODO: 最初のメッセージから生成
    lastMessage: item.initialMessage || '対話を開始してください',
    updatedAt: new Date(item.createdAt).toISOString(),
    instanceStatus: item.instanceStatus || 'terminated',
    sessionCost: item.sessionCost, // 各セッションのコスト情報を追加
  }));

  return { sessions };
});
