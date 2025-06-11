import { agentStatusSchema } from '@remote-swe-agents/agent-core/schema';
import { z } from 'zod';

export const sendMessageToAgentSchema = z.object({
  workerId: z.string(),
  message: z.string(),
  imageKeys: z.array(z.string()).optional(),
});

export const updateAgentStatusSchema = z.object({
  workerId: z.string(),
  status: agentStatusSchema,
});
