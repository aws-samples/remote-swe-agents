import { z } from 'zod';

// Schema for prompt saving
export const savePromptSchema = z.object({
  additionalSystemPrompt: z.string().optional(),
});

export const modelConfigSchema = z.object({
  modelId: z.string().min(1, 'Model ID is required'),
});
