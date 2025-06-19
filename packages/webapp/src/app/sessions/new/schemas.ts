import { z } from 'zod';

export const createNewWorkerSchema = z.object({
  message: z.string().min(1),
  imageKeys: z.array(z.string()).optional(),
});

export const promptTemplateSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
});

export const updatePromptTemplateSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  content: z.string().min(1),
});

export const deletePromptTemplateSchema = z.object({
  id: z.string(),
});
