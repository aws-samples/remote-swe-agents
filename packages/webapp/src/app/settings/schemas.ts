import { z } from 'zod';

export const modelConfigSchema = z.object({
  modelId: z.string().min(1, 'Model ID is required'),
});
