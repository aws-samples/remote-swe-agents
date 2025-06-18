import { Handler } from 'aws-lambda';
import { App, AwsLambdaReceiver, LogLevel } from '@slack/bolt';
import z from 'zod';
import { getOrCreateWorkerInstance } from '@remote-swe-agents/agent-core/lib';
import { makeIdempotent } from './util/idempotency';
import { IdempotencyAlreadyInProgressError, IdempotencyConfig } from '@aws-lambda-powertools/idempotency';

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
      // When the handler is invoked more than once in short interval,
      // the second invocation launches another instance because
      // DescribeInstances does not return the instance launched from
      // the first invocation very soon. To avoid it, we use makeIdempotent here.
      await makeIdempotent(
        async (_: string) => {
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
        },
        { config: new IdempotencyConfig({ expiresAfterSeconds: 30 }) }
      )(`ensureInstance-${event.workerId}`);
    } catch (e) {
      console.error(e);
      if (e instanceof IdempotencyAlreadyInProgressError) return;
      await app.client.chat.postMessage({
        channel: event.slackChannelId,
        thread_ts: event.slackThreadTs,
        text: `An error occurred in worker manager: ${e}`,
      });
    }
  }
};
