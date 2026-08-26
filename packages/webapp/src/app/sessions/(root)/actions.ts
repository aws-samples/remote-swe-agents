'use server';

import { updateSessionAgentStatus } from '@remote-swe-agents/agent-core/lib';
import { authActionClient } from '@/lib/safe-action';
import { z } from 'zod';
import { agentStatusSchema } from '@remote-swe-agents/agent-core/schema';
import { runJob } from '@/lib/jobs';
import { MAX_BATCH_DELETE_SIZE } from './constants';

const deleteSessionSchema = z.object({
  workerId: z.string(),
});

export const deleteSessionAction = authActionClient.inputSchema(deleteSessionSchema).action(async ({ parsedInput }) => {
  const { workerId } = parsedInput;
  // Deleting a single session (and its descendants/messages) is offloaded to
  // the same async background job as batch deletion so that large sessions do
  // not exceed the CloudFront origin response timeout. Completion is reported
  // via the `sessionDeleted` realtime event.
  await runJob({ type: 'sessionBatchDelete', workerIds: [workerId] });
  return { accepted: true };
});

const batchDeleteSessionsSchema = z.object({
  workerIds: z.array(z.string()).min(1).max(MAX_BATCH_DELETE_SIZE),
});

export const batchDeleteSessionsAction = authActionClient
  .inputSchema(batchDeleteSessionsSchema)
  .action(async ({ parsedInput }) => {
    const { workerIds } = parsedInput;
    // Deleting sessions (and their descendants/messages) can take well over the
    // CloudFront origin response timeout under DynamoDB throttling. Offload the
    // work to the async job Lambda and return immediately; the webapp tracks
    // per-session completion via the `sessionDeleted` realtime event.
    await runJob({ type: 'sessionBatchDelete', workerIds });
    return { accepted: true, count: workerIds.length };
  });

const updateStatusSchema = z.object({
  workerId: z.string(),
  status: agentStatusSchema,
});

export const updateAgentStatusFromListAction = authActionClient
  .inputSchema(updateStatusSchema)
  .action(async ({ parsedInput }) => {
    const { workerId, status } = parsedInput;
    await updateSessionAgentStatus(workerId, status);
    return { success: true };
  });
