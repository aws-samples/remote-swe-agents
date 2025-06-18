import { agentStatusSchema } from '@remote-swe-agents/agent-core/schema';
import { z } from 'zod';

export const sendMessageToAgentSchema = z.object({
  workerId: z.string(),
  message: z.string(),
  imageKeys: z.array(z.string()).optional(),
});

export const fetchTodoListSchema = z.object({
  workerId: z.string(),
});

export const updateAgentStatusSchema = z.object({
  workerId: z.string(),
  status: agentStatusSchema,
});

export const sendEventSchema = z.object({
  workerId: z.string(),
  event: z.object({
    type: z.literal('forceStop'),
  }),
});
