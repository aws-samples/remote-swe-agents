'use server';

import { authActionClient } from '@/lib/safe-action';
import { runTranslateJobSchema } from './schemas';
import { runJob } from '@/lib/jobs';
import { sendEvent } from '@/lib/events';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { renderUserMessage } from '@remote-swe-agents/agent-core/lib';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { z } from 'zod';

const lambda = new LambdaClient({});

export const runTranslateJob = authActionClient.schema(runTranslateJobSchema).action(async ({ parsedInput, ctx }) => {
  await runJob({
    type: 'example',
  });
});

// セッション作成
export const createNewSession = authActionClient
  .schema(z.object({}))
  .action(async ({ ctx }) => {
    const workerId = `session-${Date.now()}`;
    
    // セッション情報をDynamoDBに保存
    await ddb.send(
      new PutCommand({
        TableName,
        Item: {
          PK: 'sessions',
          SK: workerId,
          workerId,
          createdAt: Date.now(),
          LSI1: String(Date.now()).padStart(15, '0'),
        },
      })
    );

    return { workerId };
  });

// メッセージ送信
export const sendMessageToAgent = authActionClient
  .schema(z.object({
    workerId: z.string(),
    message: z.string(),
    imageKeys: z.array(z.string()).optional()
  }))
  .action(async ({ parsedInput: { workerId, message, imageKeys = [] }, ctx }) => {
    const { userId } = ctx;

    // メッセージをDynamoDBに保存
    const content = [];
    if (message) {
      content.push({ text: renderUserMessage({ message }) });
    }
    imageKeys.forEach((key) => {
      content.push({
        image: {
          format: 'webp',
          source: {
            s3Key: key,
          },
        },
      });
    });

    await ddb.send(
      new PutCommand({
        TableName,
        Item: {
          PK: `message-${workerId}`,
          SK: `${String(Date.now()).padStart(15, '0')}`,
          content: JSON.stringify(content),
          role: 'user',
          tokenCount: 0,
          messageType: 'userMessage',
          slackUserId: userId,
        },
      })
    );

    // Events APIでworkerに通知
    await sendEvent(workerId, 'onMessageReceived');

    // Worker起動処理（非同期）
    const AsyncLambdaName = process.env.ASYNC_LAMBDA_NAME;
    if (AsyncLambdaName) {
      await lambda.send(
        new InvokeCommand({
          FunctionName: AsyncLambdaName,
          Payload: JSON.stringify({
            type: 'ensureInstance',
            workerId,
            slackChannelId: '', // webappからは空
            slackThreadTs: '',
          }),
          InvocationType: 'Event',
        })
      );
    }

    return { success: true };
  });

// セッション一覧取得
export const getSessions = authActionClient
  .schema(z.object({}))
  .action(async ({ ctx }) => {
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

    const sessions = (res.Items || []).map(item => ({
      workerId: item.workerId,
      createdAt: item.createdAt,
      title: `セッション ${item.workerId}`, // TODO: 最初のメッセージから生成
      lastMessage: '対話を開始してください',
      updatedAt: new Date(item.createdAt).toISOString(),
    }));

    return { sessions };
  });
