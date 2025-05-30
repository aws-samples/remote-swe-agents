import { Handler } from 'aws-lambda';
import { App, AwsLambdaReceiver, LogLevel } from '@slack/bolt';
import z from 'zod';
import { getOrCreateWorkerInstance } from '@remote-swe-agents/agent-core/lib';

const BotToken = process.env.BOT_TOKEN!;

export const receiver = new AwsLambdaReceiver({
  signingSecret: 'dummy',
});

const app = new App({
  token: BotToken,
  receiver,
  logLevel: LogLevel.DEBUG,
  developerMode: true,
  socketMode: false,
});

const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ensureInstance'),
    workerId: z.string(),
    slackChannelId: z.string(),
    slackThreadTs: z.string(),
  }),
]);

export type AsyncHandlerEvent = z.infer<typeof eventSchema>;

// slack api timeouts in just a 3 seconds so we run actual process asynchronously
// we might not need this because idempotency using dynamodb lock almost resolved the problem.
export const handler: Handler<unknown> = async (rawEvent, context) => {
  const event = eventSchema.parse(rawEvent);
  if (event.type == 'ensureInstance') {
    try {
      const res = await getOrCreateWorkerInstance(event.workerId, event.slackChannelId, event.slackThreadTs);

      if (res.oldStatus == 'stopped') {
        await app.client.chat.postMessage({
          channel: event.slackChannelId,
          thread_ts: event.slackThreadTs,
          text: `Waking up from sleep mode...`,
        });
      } else if (res.oldStatus == 'terminated') {
        await app.client.chat.postMessage({
          channel: event.slackChannelId,
          thread_ts: event.slackThreadTs,
          text: `Preparing for a new instance${res.usedCache ? ' (using a cached AMI)' : ''}...`,
        });
      }
    } catch (e) {
      console.error(e);
      await app.client.chat.postMessage({
        channel: event.slackChannelId,
        thread_ts: event.slackThreadTs,
        text: `An error occurred in worker manager: ${e}`,
      });
    }
  }
};
