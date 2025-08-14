import { z } from 'zod';

// Schema for prompt saving
export const savePromptSchema = z.object({
  additionalSystemPrompt: z.string().optional(),
});
