import { z } from 'zod';
import { isAgentStatus } from '@remote-swe-agents/agent-core/schema';

export const sendMessageToAgentSchema = z.object({
  workerId: z.string(),
  message: z.string(),
  imageKeys: z.array(z.string()).optional(),
});

export const updateAgentStatusSchema = z.object({
  workerId: z.string(),
  status: z.string().refine(isAgentStatus, {
    message: 'Invalid status. Must be one of: working, pending, completed',
  }),
});
