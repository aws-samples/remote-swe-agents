import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { WebClient } from '@slack/web-api';
import { saveConversationHistory } from '../util/history';
import { s3, BucketName, getParameter } from '@remote-swe-agents/agent-core/aws';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { AsyncHandlerEvent } from '../async-handler';
import { sendWorkerEvent } from '../../../agent-core/src/lib';
import { saveSessionInfo, sendWebappEvent } from '@remote-swe-agents/agent-core/lib';

const BotToken = process.env.BOT_TOKEN!;
const lambda = new LambdaClient();
const AsyncLambdaName = process.env.ASYNC_LAMBDA_NAME!;

export async function handleMessage(
  event: {
    text: string;
    user?: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    blocks?: any[];
    files?: any[];
  },
  client: WebClient
): Promise<void> {
  const message = event.text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  const userId = event.user ?? '';
  const channel = event.channel;

  const workerId = (event.thread_ts ?? event.ts).replace('.', '');

  // Process image attachments if present
  const imageKeys = (
    await Promise.all(
      event.files
        ?.filter((file: { mimetype?: string }) => file?.mimetype?.startsWith('image/'))
        .map(async (file: { id: string; mimetype?: string }) => {
          const image = await client.files.info({
            file: file.id,
          });

          if (image.file?.url_private_download && image.file.filetype && image.file.mimetype) {
            const fileContent = await fetch(image.file.url_private_download, {
              headers: { Authorization: `Bearer ${BotToken}` },
            }).then((res) => res.arrayBuffer());

            const key = `${workerId}/${file.id}.${image.file.filetype}`;
            await s3.send(
              new PutObjectCommand({
                Bucket: BucketName,
                Key: key,
                Body: Buffer.from(fileContent),
                ContentType: image.file.mimetype,
              })
            );

            return key;
          }
        }) ?? []
    )
  ).filter((key) => key != null);

  const region = process.env.AWS_REGION!;
  const logStreamName = `log-${workerId}`;
  const logGroupName = process.env.LOG_GROUP_NAME!;
  const cloudwatchUrl = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(logGroupName)}/log-events/${encodeURIComponent(logStreamName)}`;

  // Get webapp domain from SSM parameter
  const originSourceParameterName = process.env.APP_ORIGIN_SOURCE_PARAMETER;
  let webappUrl = undefined;
  
  if (originSourceParameterName) {
    try {
      webappUrl = await getParameter(originSourceParameterName);
      console.log(`Retrieved webapp URL: ${webappUrl}`);
    } catch (error) {
      console.error('Error retrieving webapp URL:', error);
    }
  }

  const promises = [
    saveConversationHistory(workerId, message, userId, imageKeys),
    sendWorkerEvent(workerId, { type: 'onMessageReceived' }),
    sendWebappEvent(workerId, { type: 'message', role: 'user', message }),
    lambda.send(
      new InvokeCommand({
        FunctionName: AsyncLambdaName,
        Payload: JSON.stringify({
          type: 'ensureInstance',
          workerId,
          slackChannelId: event.channel,
          slackThreadTs: event.ts,
        } satisfies AsyncHandlerEvent),
        InvocationType: 'Event',
      })
    ),
  ];

  // Save session info only when starting a new thread
  if (event.thread_ts === undefined) {
    promises.push(saveSessionInfo(workerId, message));
  }

  await Promise.all([
    ...promises,
    // Send initial message only when starting a new thread
    event.thread_ts === undefined
      ? client.chat.postMessage({
          channel: channel,
          thread_ts: event.ts,
          text: `Hi, please wait for your agent to launch.`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `Hi <@${userId}>, please wait for your agent to launch.\n\n*Useful Tips:*`,
              },
            },
            // Add additional sections with tips
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `• You can view <${cloudwatchUrl}|*the execution log here*>`,
              },
            },
            // Conditionally add webapp link if available
            ...(webappUrl ? [{
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `• View this session in WebApp: <${webappUrl}/sessions/${workerId}|*Open in Web UI*>`,
              },
            }] : []),
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '• Send `dump_history` to get conversation history and token consumption stats.',
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '• You can always interrupt and ask them to stop what they are doing.',
              },
            },
          ],
        })
      : client.reactions.add({
          channel: channel,
          name: 'eyes',
          timestamp: event.ts,
        }),
  ]);
}
