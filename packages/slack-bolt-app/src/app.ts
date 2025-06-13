import { App, AwsLambdaReceiver, LogLevel, SlackEventMiddlewareArgs } from '@slack/bolt';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { saveConversationHistory, getConversationHistory, getTokenUsage } from './util/history';
import { makeIdempotent } from './util/idempotency';
import { ApproveUsers, isAuthorized } from './util/auth';
import { calculateCost } from './util/cost';
import * as fs from 'fs';
import * as os from 'os';
import { Message } from '@aws-sdk/client-bedrock-runtime';
import { s3, BucketName } from '@remote-swe-agents/agent-core/aws';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { IdempotencyAlreadyInProgressError } from '@aws-lambda-powertools/idempotency';
import { AsyncHandlerEvent } from './async-handler';
import { sendWorkerEvent } from '../../agent-core/src/lib';
import { saveSessionInfo, sendWebappEvent } from '@remote-swe-agents/agent-core/lib';

const SigningSecret = process.env.SIGNING_SECRET!;
const BotToken = process.env.BOT_TOKEN!;
const lambda = new LambdaClient();
const AsyncLambdaName = process.env.ASYNC_LAMBDA_NAME!;

export const receiver = new AwsLambdaReceiver({
  signingSecret: SigningSecret,
});

const app = new App({
  token: BotToken,
  receiver: receiver,
  logLevel: LogLevel.DEBUG,
  developerMode: true,
  socketMode: false,
});

// Variable to store the bot's own ID
let botId: string | undefined;

// Retrieve the bot ID on app startup
(async () => {
  try {
    const authInfo = await app.client.auth.test();
    botId = authInfo.user_id;
    console.log(`Bot ID retrieved: ${botId}`);
  } catch (error) {
    console.error('Failed to retrieve bot ID:', error);
  }
})();

// Common message processing function for both app_mention and message events
async function processMessage(
  event: {
    text: string;
    user?: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    blocks?: any[];
    files?: any[];
  },
  client: any,
  logger: any,
  eventType: 'app_mention' | 'message'
) {
  console.log(`${eventType} event received`);
  console.log(JSON.stringify(event));

  const message = event.text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  const userId = event.user ?? '';
  const channel = event.channel;

  try {
    // Include event type in idempotency key to prevent duplicate processing
    await makeIdempotent(async (_: string) => {
      const authorized = await isAuthorized(userId, channel);
      if (!authorized) {
        throw new Error('Unauthorized');
      }
      if (message.toLowerCase().startsWith('approve_user')) {
        const block = event.blocks?.[0];
        if (block != null && 'elements' in block) {
          const element = block.elements[0];
          if (element.type == 'rich_text_section') {
            const users = element.elements
              .slice(1)
              .filter((elem: any) => elem.type == 'user')
              .map((elem: any) => elem.user_id);
            if (users.length >= 25) {
              throw new Error('too many users.');
            }
            if (users.length == 0) {
              throw new Error('no user is specified.');
            }
            await ApproveUsers(users, channel);
            await client.chat.postMessage({
              channel,
              thread_ts: event.thread_ts ?? event.ts,
              text: `<@${userId}> Successfully approved ${users.length} user(s) in this channel!`,
            });
            return;
          }
        }
        throw new Error('Usage: @remote-swe approve_user @user1 @user2');
      }

      if (message.toLowerCase().startsWith('dump_history')) {
        const workerId = (event.thread_ts ?? event.ts).replace('.', '');
        const [history, tokenUsage] = await Promise.all([getConversationHistory(workerId), getTokenUsage(workerId)]);

        const tempFile = os.tmpdir() + `/worker_${workerId}_history.txt`;
        const stringifyMessage = (
          message: {
            timestamp: string;
          } & Message
        ) => {
          const stripAnsiSequences = (text: string) => {
            return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
          };

          const prefix = `[${message.timestamp}] ${message.role}:`;
          const content = message.content
            ?.map((c: any) => {
              if (c.text != null) {
                return stripAnsiSequences(c.text);
              } else if (c.toolUse != null) {
                return stripAnsiSequences(
                  `<TOOL USE: ${c.toolUse?.name} ${c.toolUse.toolUseId}> ${JSON.stringify(c.toolUse.input)}`
                );
              } else if (c.toolResult != null) {
                return stripAnsiSequences(`<TOOL RESULT: ${c.toolResult.toolUseId}> ${c.toolResult.content?.[0].text}`);
              } else if (c.image != null) {
                return `[IMAGE: ${c.image.source.s3Key}]`;
              }
            })
            .join('\n\n');
          return `${prefix} ${content}`;
        };

        const tokenSummary = tokenUsage
          .map((item) => {
            const cost = calculateCost(
              item.SK,
              item.inputToken,
              item.outputToken,
              item.cacheReadInputTokens,
              item.cacheWriteInputTokens
            );
            return (
              `Model: ${item.SK}\n` +
              `Input tokens: ${item.inputToken}\n` +
              `Output tokens: ${item.outputToken}\n` +
              `Cache Read tokens: ${item.cacheReadInputTokens}\n` +
              `Cache Write tokens: ${item.cacheWriteInputTokens}\n` +
              `Cost: ${cost.toFixed(4)} USD`
            );
          })
          .join('\n\n');

        const totalCost = tokenUsage.reduce((acc, item) => {
          return (
            acc +
            calculateCost(
              item.SK,
              item.inputToken,
              item.outputToken,
              item.cacheReadInputTokens,
              item.cacheWriteInputTokens
            )
          );
        }, 0);

        const totalInputTokens = tokenUsage.reduce((acc, item) => acc + item.inputToken, 0);
        const totalOutputTokens = tokenUsage.reduce((acc, item) => acc + item.outputToken, 0);
        const totalCacheReadTokens = tokenUsage.reduce((acc, item) => acc + item.cacheReadInputTokens, 0);
        const totalCacheWriteTokens = tokenUsage.reduce((acc, item) => acc + item.cacheWriteInputTokens, 0);

        const historyText =
          `=== Token Usage Summary ===\n` +
          `Total Input Tokens: ${totalInputTokens}\n` +
          `Total Output Tokens: ${totalOutputTokens}\n` +
          `Cache Read tokens: ${totalCacheReadTokens}\n` +
          `Cache Write tokens: ${totalCacheWriteTokens}\n` +
          `Total Cost: ${totalCost.toFixed(4)} USD\n\n` +
          `=== Per Model Breakdown ===\n` +
          `${tokenSummary}\n\n` +
          `=== Conversation History ===\n` +
          history.map((msg) => stringifyMessage(msg)).join('\n');

        fs.writeFileSync(tempFile, historyText);
        const uploadResult = await client.files.uploadV2({
          channel_id: channel,
          thread_ts: event.thread_ts ?? event.ts,
          file: fs.readFileSync(tempFile),
          filename: `worker_${workerId}_history.txt`,
          initial_comment: `Message history for worker ${workerId}`,
        });
        fs.unlinkSync(tempFile);
        return;
      }

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
                {
                  type: 'rich_text',
                  elements: [
                    {
                      type: 'rich_text_list',
                      style: 'bullet',
                      indent: 0,
                      elements: [
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
    })(`${eventType}_${event.ts}`); // Use event type in key to avoid duplicates
  } catch (e: any) {
    console.log(e);
    if (e.message.includes('already_reacted')) return;
    if (e instanceof IdempotencyAlreadyInProgressError) return;

    await client.chat.postMessage({
      channel,
      text: `<@${userId}> Error occurred ${e.message}`,
      thread_ts: event.thread_ts ?? event.ts,
    });
  }
}

app.event('app_mention', async ({ event, client, logger }) => {
  await processMessage(event, client, logger, 'app_mention');
});

// Message event handler for processing messages without @mentions
app.event('message', async ({ event, client, logger }) => {
  // Cast event to a type with properties we need
  const messageEvent = event as {
    text?: string;
    bot_id?: string;
    subtype?: string;
    channel_type?: string;
    thread_ts?: string;
    user?: string;
    channel: string;
    ts: string;
    blocks?: any[];
    files?: any[];
  };

  // Skip if from a bot
  if (messageEvent.bot_id) {
    return;
  }

  // Skip if no text AND no files (empty message)
  if (!messageEvent.text && !messageEvent.files?.length) {
    return;
  }

  // Skip certain subtypes but allow those with files
  if (messageEvent.subtype && !messageEvent.files?.length) {
    return;
  }

  // Skip if message mentions this bot (will be handled by app_mention)
  if (botId && messageEvent.text && messageEvent.text.includes(`<@${botId}>`)) {
    console.log('Message contains mention to this bot, skipping to avoid duplication');
    return;
  }

  // Create event object with guaranteed non-undefined text property
  const safeEvent = {
    ...messageEvent,
    // Ensure text is always a string (fallback to empty string if undefined)
    text: messageEvent.text || '',
  };

  // Process thread replies
  if (messageEvent.thread_ts) {
    await processMessage(safeEvent, client, logger, 'message');
  }
  // Process direct messages
  else if (messageEvent.channel_type === 'im') {
    await processMessage(safeEvent, client, logger, 'message');
  }
});

export default app;
