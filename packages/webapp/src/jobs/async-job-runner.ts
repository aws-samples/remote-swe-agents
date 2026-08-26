import { Handler } from 'aws-lambda';
import { z } from 'zod';
import { deleteSession, sendWebappEvent } from '@remote-swe-agents/agent-core/lib';

const jobPayloadPropsSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('example'),
  }),
  z.object({
    type: z.literal('sessionBatchDelete'),
    workerIds: z.array(z.string()).min(1),
  }),
]);

export type JobPayloadProps = z.infer<typeof jobPayloadPropsSchema>;

export const handler: Handler<unknown> = async (event, context) => {
  const { data: payload, error } = jobPayloadPropsSchema.safeParse(event);
  if (error) {
    // Do not throw: an unrecognized payload (e.g. the legacy scheduled
    // SampleJob that emits `{ jobType, payload }`) should be ignored quietly
    // rather than failing the invocation and triggering scheduler retries.
    console.log('Ignoring async job with unrecognized payload:', error.toString());
    return;
  }

  switch (payload.type) {
    case 'example':
      console.log('example job processed');
      break;
    case 'sessionBatchDelete':
      await processSessionBatchDelete(payload.workerIds);
      break;
  }
};

const SESSION_DELETE_CONCURRENCY = 3;

async function processSessionBatchDelete(workerIds: string[]): Promise<void> {
  for (let i = 0; i < workerIds.length; i += SESSION_DELETE_CONCURRENCY) {
    const chunk = workerIds.slice(i, i + SESSION_DELETE_CONCURRENCY);
    await Promise.all(
      chunk.map(async (workerId) => {
        let success = false;
        try {
          await deleteSession(workerId);
          success = true;
        } catch (e) {
          console.error(`Failed to delete session ${workerId}:`, e);
        }
        // Notify the webapp so it can update the session list in realtime.
        await sendWebappEvent(workerId, { type: 'sessionDeleted', success });
      })
    );
  }
}
