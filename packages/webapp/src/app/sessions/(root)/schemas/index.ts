import { z } from 'zod';

export const updateSessionTitleSchema = z.object({
  workerId: z.string(),
  title: z.string().min(1).max(100),
});