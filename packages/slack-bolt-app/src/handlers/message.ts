import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { WebClient } from '@slack/web-api';
import { saveConversationHistory } from '../util/history';
import { s3, BucketName } from '@remote-swe-agents/agent-core/aws';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { AsyncHandlerEvent } from '../async-handler';
import { sendWorkerEvent } from '../../../agent-core/src/lib';
import { getWebappSessionUrl, sendWebappEvent } from '@remote-swe-agents/agent-core/lib';
import { saveSessionInfo } from '../util/session';
import { getSessionIdFromSlack } from '../util/session-map';

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
  const isThreadRoot = event.thread_ts == null;

  const workerId = await getSessionIdFromSlack(channel, event.thread_ts ?? event.ts, isThreadRoot);

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

  const sessionUrl = await getWebappSessionUrl(workerId);

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
    promises.push(saveSessionInfo(workerId, message, userId, event.channel, event.ts));
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
            {
              type: 'rich_text',
              elements: [
                {
                  type: 'rich_text_list',
                  style: 'bullet',
                  indent: 0,
                  elements: [
                    ...(sessionUrl
                      ? [
                          {
                            type: 'rich_text_section',
                            elements: [
                              {
                                type: 'text',
                                text: 'View this session in WebApp: ',
                              },
                              {
                                type: 'link',
                                url: sessionUrl,
                                text: 'Open in Web UI',
                                style: {
                                  bold: true,
                                },
                              },
                            ],
                          } as any,
                        ]
                      : [
                          {
                            type: 'rich_text_section',
                            elements: [
                              {
                                type: 'text',
                                text: 'You can view ',
                              },
                              {
                                type: 'link',
                                url: cloudwatchUrl,
                                text: 'the execution log here',
                                style: {
                                  bold: true,
                                },
                              },
                            ],
                          },
                        ]),
                    {
                      type: 'rich_text_section',
                      elements: [
                        {
                          type: 'text',
                          text: 'Send ',
                        },
                        {
                          type: 'text',
                          text: 'dump_history',
                          style: {
                            code: true,
                          },
                        },
                        {
                          type: 'text',
                          text: ' to get conversation history and token consumption stats.',
                        },
                      ],
                    },
                    {
                      type: 'rich_text_section',
                      elements: [
                        {
                          type: 'text',
                          text: 'You can always interrupt and ask them to stop what they are doing.',
                        },
                      ],
                    },
                  ],
                },
              ],
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
