import { z } from 'zod';

export const createNewWorkerSchema = z.object({
  message: z.string().min(1),
  imageKeys: z.array(z.string()).optional(),
});

export const promptTemplateSchema = z.object({
  title: z.string().min(1, 'タイトルは必須です'),
  content: z.string().min(1, '内容は必須です'),
});

export const updatePromptTemplateSchema = z.object({
  id: z.string(),
  title: z.string().min(1, 'タイトルは必須です'),
  content: z.string().min(1, '内容は必須です'),
});

export const deletePromptTemplateSchema = z.object({
  id: z.string(),
});
