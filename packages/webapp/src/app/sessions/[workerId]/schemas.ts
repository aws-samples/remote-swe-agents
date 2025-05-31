import { z } from 'zod';

export const sendMessageToAgentSchema = z.object({
  workerId: z.string(),
  message: z.string(),
  imageKeys: z.array(z.string()).optional(),
});
