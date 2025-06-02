import { randomBytes } from 'crypto';

export const WorkerId = process.env.WORKER_ID ?? randomBytes(10).toString('hex');

export const SlackBotToken = process.env.SLACK_BOT_TOKEN!;
export const SlackChannelId = process.env.SLACK_CHANNEL_ID!;
export const SlackThreadTs = process.env.SLACK_THREAD_TS!;
