'use server';

import { updateSessionVisibility, deleteSession, updateSessionAgentStatus } from '@remote-swe-agents/agent-core/lib';
import { authActionClient } from '@/lib/safe-action';
import { z } from 'zod';
import { agentStatusSchema } from '@remote-swe-agents/agent-core/schema';

const hideSessionSchema = z.object({
  workerId: z.string(),
});

export const hideSessionAction = authActionClient
  .inputSchema(hideSessionSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { workerId } = parsedInput;
    await updateSessionVisibility(workerId, true);
    return { success: true };
  });

const deleteSessionSchema = z.object({
  workerId: z.string(),
});

export const deleteSessionAction = authActionClient.inputSchema(deleteSessionSchema).action(async ({ parsedInput }) => {
  const { workerId } = parsedInput;
  await deleteSession(workerId);
  return { success: true };
});

const batchDeleteSessionsSchema = z.object({
  workerIds: z.array(z.string()).min(1),
});

export const batchDeleteSessionsAction = authActionClient
  .inputSchema(batchDeleteSessionsSchema)
  .action(async ({ parsedInput }) => {
    const { workerIds } = parsedInput;
    await Promise.all(workerIds.map((workerId) => deleteSession(workerId)));
    return { success: true, count: workerIds.length };
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
