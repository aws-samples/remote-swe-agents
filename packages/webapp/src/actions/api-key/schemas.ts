import { z } from 'zod';

export const createApiKeySchema = z.object({
  description: z.string().optional(),
});

export const deleteApiKeySchema = z.object({
  apiKey: z.string(),
});
