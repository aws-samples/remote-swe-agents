import { App, AwsLambdaReceiver, LogLevel } from '@slack/bolt';
import { readFileSync } from 'fs';
import { sendWebappEvent } from './';

const BotToken = process.env.SLACK_BOT_TOKEN!;
const channelId = process.env.SLACK_CHANNEL_ID!;
const threadTs = process.env.SLACK_THREAD_TS!;
const disableSlack = !(channelId && threadTs)

export const receiver = new AwsLambdaReceiver({
  // We don't need signingSecret because we use slack bolt only to send messages here.
  signingSecret: 'dummy',
});

let app: App | undefined = undefined;

const getApp = () => {
  if (app) return app;
  app = new App({
    token: BotToken,
    receiver,
    logLevel: LogLevel.DEBUG,
    developerMode: true,
    socketMode: false,
  });
  return app;
};

/**
 * Processes message text to ensure URLs are properly linked in Slack messages
 * Adds a space before http:// or https:// if it's not preceded by a whitespace or newline
 */
const processMessageForLinks = (message: string): string => {
  // Look for http:// or https://
  const parts = message.split(/(https?:\/\/)/g);
  let result = '';

  for (let i = 0; i < parts.length; i++) {
    // If this part is http:// or https://
    if (parts[i] === 'http://' || parts[i] === 'https://') {
      // If not at the beginning and previous character isn't whitespace or newline
      if (i > 0 && result.length > 0) {
        const lastChar = result[result.length - 1];
        if (lastChar !== ' ' && lastChar !== '\n' && lastChar !== '\t') {
          // Add space before the URL protocol
          result += ' ';
        }
      }
    }
    result += parts[i];
  }

  return result;
};

export const sendMessageToSlack = async (message: string) => {
  // TODO
  await sendWebappEvent('', {type: 'userMessage', payload: {} as any});

  if (disableSlack) {
    console.log(`[Slack] ${message}`);
    return;
  }

  // Process message to ensure proper URL linking
  const processedMessage = processMessageForLinks(message);

  await getApp().client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    // limit to 40000 chars https://api.slack.com/methods/chat.postMessage#truncating
    text: processedMessage.slice(0, 40000),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          // limit to 12000 chars https://api.slack.com/reference/block-kit/blocks#markdown
          text: processedMessage.slice(0, 12000),
        },
      },
    ],
  });
};

export const sendFileToSlack = async (imagePath: string, message: string) => {
  if (disableSlack) {
    console.log(`[Slack] Image: ${imagePath}, Message: ${message}`);
    return;
  }

  const fileName = imagePath.split('/').pop() || 'image';
  const imageBuffer = readFileSync(imagePath);

  // Process message to ensure proper URL linking
  const processedMessage = processMessageForLinks(message);

  const result = await getApp().client.filesUploadV2({
    channel_id: channelId,
    thread_ts: threadTs,
    initial_comment: processedMessage,
    filename: fileName,
    file: imageBuffer,
  });

  if (!result.ok) {
    throw new Error(`Failed to upload image: ${result.error}`);
  }

  return result;
};
