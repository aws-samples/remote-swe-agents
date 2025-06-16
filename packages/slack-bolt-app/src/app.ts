import { App, AwsLambdaReceiver, LogLevel } from '@slack/bolt';
import { makeIdempotent } from './util/idempotency';
import { isAuthorized } from './util/auth';
import { handleDumpHistory } from './handlers/dump-history';
import { handleApproveUser } from './handlers/approve-user';
import { handleMessage } from './handlers/message';
import { IdempotencyAlreadyInProgressError } from '@aws-lambda-powertools/idempotency';
import { WebClient } from '@slack/web-api';

const SigningSecret = process.env.SIGNING_SECRET!;
const BotToken = process.env.BOT_TOKEN!;

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
  client: WebClient,
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
        await handleApproveUser(event, client);
      } else if (message.toLowerCase().startsWith('dump_history')) {
        await handleDumpHistory(event, client);
      } else {
        await handleMessage(event, client);
      }
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

app.event('app_mention', async ({ event, client }) => {
  await processMessage(event, client, 'app_mention');
});

// Message event handler for processing messages without @mentions
app.event('message', async ({ event, client }) => {
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
    await processMessage(safeEvent, client, 'message');
  }
  // Process direct messages
  else if (messageEvent.channel_type === 'im') {
    await processMessage(safeEvent, client, 'message');
  }
});

export default app;
