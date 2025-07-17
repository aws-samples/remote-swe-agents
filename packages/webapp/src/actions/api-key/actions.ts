'use server';

import { createApiKey, deleteApiKey, getApiKeys } from '@remote-swe-agents/agent-core/lib';
import { ApiKeyItem } from '@remote-swe-agents/agent-core/schema';
import { authActionClient } from '@/lib/safe-action';
import { createApiKeySchema, deleteApiKeySchema } from './schemas';

export const listApiKeysAction = authActionClient.action(async (_, { userId }) => {
  const apiKeys = await getApiKeys();
  return { apiKeys };
});

export const createApiKeyAction = authActionClient
  .inputSchema(createApiKeySchema)
  .action(async ({ description }, { userId }) => {
    const apiKey = await createApiKey(description, userId);
    return { apiKey };
  });

export const deleteApiKeyAction = authActionClient.inputSchema(deleteApiKeySchema).action(async ({ apiKey }) => {
  await deleteApiKey(apiKey);
  return { success: true };
});
