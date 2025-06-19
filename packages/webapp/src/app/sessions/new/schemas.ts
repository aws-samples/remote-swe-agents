import { z } from 'zod';

export const createNewWorkerSchema = z.object({
  message: z.string().min(1),
  imageKeys: z.array(z.string()).optional(),
});

export const promptTemplateSchema = z.object({
  PK: z.literal('prompt-template'),
  SK: z.string(),
  content: z.string(),
  createdAt: z.number(),
});

export type PromptTemplate = z.infer<typeof promptTemplateSchema>;
