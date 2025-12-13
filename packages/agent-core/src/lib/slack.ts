import type { App } from '@slack/bolt';
import { readFileSync } from 'fs';

const SlackBotToken = process.env.SLACK_BOT_TOKEN!;
let disableSlack = true;
let SlackChannelId = '';
let SlackThreadTs = '';

export const setSlackDestination = (channelId: string, threadTs: string) => {
  SlackChannelId = channelId;
  SlackThreadTs = threadTs;
  disableSlack = false;
};

let _app: App | undefined = undefined;

const getApp = async () => {
  if (_app) return _app;
  const { App, AwsLambdaReceiver, LogLevel } = await import('@slack/bolt');

  const receiver = new AwsLambdaReceiver({
    // We don't need signingSecret because we use slack bolt only to send messages here.
    signingSecret: 'dummy',
  });

  _app = new App({
    token: SlackBotToken,
    receiver,
    logLevel: LogLevel.DEBUG,
    developerMode: true,
    socketMode: false,
  });
  return _app;
};

/**
 * Processes message text to ensure URLs are properly linked in Slack messages
 * Adds a space before http:// or https:// if it's not preceded by a whitespace or newline
 */
const processMessageForLinks = (message: string): string => {
  // Look for http:// or https://
  const parts = message.trim().split(/(https?:\/\/)/g);
  let result = '';

  for (let i = 0; i < parts.length; i++) {
    // If this part is http:// or https://
    if (parts[i] === 'http://' || parts[i] === 'https://') {
      // If not at the beginning and previous character isn't whitespace or newline
      // We also ignore "(" because it would break [link](https://example.com) notation.
      // We also ignore "<" because it would break <https://example.com|link> notation.
      if (i > 0 && result.length > 0) {
        const lastChar = result[result.length - 1];
        if (lastChar !== ' ' && lastChar !== '\n' && lastChar !== '\t' && lastChar !== '(' && lastChar !== '<') {
          // Add space before the URL protocol
          result += ' ';
        }
      }
    }
    result += parts[i];
  }

  return result;
};

/**
 * Split a message into chunks at newline boundaries to respect character limits
 */
const splitMessageByNewlines = (message: string, maxLength: number = 12000): string[] => {
  if (message.length <= maxLength) {
    return [message];
  }

  const chunks: string[] = [];
  let remainingMessage = message;

  while (remainingMessage.length > maxLength) {
    let splitIndex = maxLength;

    // Find the last newline within the character limit
    const lastNewlineIndex = remainingMessage.lastIndexOf('\n', maxLength);
    if (lastNewlineIndex !== -1) {
      splitIndex = lastNewlineIndex;
    }

    chunks.push(remainingMessage.substring(0, splitIndex));
    // If we split at a newline, skip the newline character
    remainingMessage = remainingMessage.substring(splitIndex + (splitIndex === lastNewlineIndex ? 1 : 0));
  }

  if (remainingMessage.length > 0) {
    chunks.push(remainingMessage);
  }

  return chunks;
};

export const sendMessageToSlack = async (message: string) => {
  if (disableSlack) {
    console.log(`[Slack] ${message}`);
    return;
  }

  // Process message to ensure proper URL linking
  const processedMessage = processMessageForLinks(message);

  if (!processedMessage) {
    return;
  }

  // Split message into chunks if it exceeds 12000 characters
  const messageChunks = splitMessageByNewlines(processedMessage, 12000);

  const app = await getApp();

  // Send each chunk as a separate message
  for (const chunk of messageChunks) {
    await app.client.chat.postMessage({
      channel: SlackChannelId,
      thread_ts: SlackThreadTs,
      text: chunk,
      blocks: [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                {
                  type: 'text',
                  text: chunk,
                },
              ],
            },
          ],
        },
      ],
    });
  }
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
  const app = await getApp();

  const result = await app.client.filesUploadV2({
    channel_id: SlackChannelId,
    thread_ts: SlackThreadTs,
    initial_comment: processedMessage,
    filename: fileName,
    file: imageBuffer,
  });

  if (!result.ok) {
    throw new Error(`Failed to upload image: ${result.error}`);
  }

  return result;
};
