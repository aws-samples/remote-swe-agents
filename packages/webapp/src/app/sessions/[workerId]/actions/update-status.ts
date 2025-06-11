import { z } from 'zod';
import { updateSessionAgentStatus } from '@remote-swe-agents/agent-core/lib';
import { isAgentStatus } from '@remote-swe-agents/agent-core/schema';
import { createSafeActionClient } from 'next-safe-action';

const actionClient = createSafeActionClient();

const updateStatusSchema = z.object({
  workerId: z.string(),
  status: z.string().refine(isAgentStatus, {
    message: 'Invalid status. Must be one of: working, pending, completed',
  }),
});

export const updateAgentStatus = actionClient.create({
  schema: updateStatusSchema,
  handle: async ({ workerId, status }) => {
    try {
      await updateSessionAgentStatus(workerId, status);
      return { success: true };
    } catch (error) {
      console.error('Error updating agent status:', error);
      return { success: false, error: 'Failed to update agent status' };
    }
  },
});
