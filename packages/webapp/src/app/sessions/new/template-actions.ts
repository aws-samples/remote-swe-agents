'use server';

import { z } from 'zod';
import { authActionClient } from '@/lib/safe-action';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { revalidatePath } from 'next/cache';
import { PromptTemplate } from './schemas';

const createTemplateSchema = z.object({
  content: z.string().min(1, 'Template content is required'),
});

const updateTemplateSchema = z.object({
  id: z.string(),
  content: z.string().min(1, 'Template content is required'),
});

const deleteTemplateSchema = z.object({
  id: z.string(),
});

export const createPromptTemplate = authActionClient.schema(createTemplateSchema).action(async ({ parsedInput }) => {
  const { content } = parsedInput;
  const now = Date.now();
  const id = now.toString();

  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: 'prompt-template',
        SK: id,
        content,
        createdAt: now,
      } satisfies PromptTemplate,
    })
  );

  revalidatePath('/sessions/new');
  return { success: true };
});

export const updatePromptTemplate = authActionClient.schema(updateTemplateSchema).action(async ({ parsedInput }) => {
  const { id, content } = parsedInput;

  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: {
        PK: 'prompt-template',
        SK: id,
      },
      UpdateExpression: 'SET content = :content',
      ExpressionAttributeValues: {
        ':content': content,
      },
    })
  );

  revalidatePath('/sessions/new');
  return { success: true };
});

export const deletePromptTemplate = authActionClient.schema(deleteTemplateSchema).action(async ({ parsedInput }) => {
  const { id } = parsedInput;

  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: {
        PK: 'prompt-template',
        SK: id,
      },
    })
  );

  revalidatePath('/sessions/new');
  return { success: true };
});
