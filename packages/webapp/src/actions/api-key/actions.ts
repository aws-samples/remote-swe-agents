'use server';

import { createApiKey, deleteApiKey, getApiKeys } from '@remote-swe-agents/agent-core/lib';
import { ApiKeyItem } from '@remote-swe-agents/agent-core/schema';
import { authActionClient } from '@/lib/safe-action';
import { createApiKeySchema, deleteApiKeySchema } from './schemas';

export const listApiKeysAction = authActionClient.action(async ({ ctx }) => {
  const apiKeys = await getApiKeys();
  return { apiKeys };
});

export const createApiKeyAction = authActionClient
  .inputSchema(createApiKeySchema)
  .action(async ({ parsedInput, ctx }) => {
    const { description } = parsedInput;
    const apiKey = await createApiKey(description, ctx.userId);
    return { apiKey };
  });

export const deleteApiKeyAction = authActionClient.inputSchema(deleteApiKeySchema).action(async ({ parsedInput }) => {
  const { apiKey } = parsedInput;
  await deleteApiKey(apiKey);
  return { success: true };
});
