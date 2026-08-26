'use server';

import { authActionClient } from '@/lib/safe-action';
import { savePromptSchema } from './schemas';
import {
  writeCommonPrompt,
  updatePreferences,
  putKiroApiKey,
  deleteKiroApiKey,
  getKiroApiKey,
  updateUserPreferences,
  getUserPreferences,
  sanitizeUserId,
} from '@remote-swe-agents/agent-core/lib';
import { updateGlobalPreferenceSchema, updateUserPreferencesSchema } from '@remote-swe-agents/agent-core/schema';
import { z } from 'zod';

export const updateAdditionalSystemPrompt = authActionClient
  .inputSchema(savePromptSchema)
  .action(async ({ parsedInput }) => {
    const { additionalSystemPrompt } = parsedInput;
    try {
      await writeCommonPrompt({
        additionalSystemPrompt: additionalSystemPrompt || '',
      });

      return { success: true };
    } catch (error) {
      console.error('Error saving prompt:', error);
      throw new Error('Failed to save prompt configuration');
    }
  });

export const updateGlobalPreferences = authActionClient
  .inputSchema(updateGlobalPreferenceSchema)
  .action(async ({ parsedInput }) => {
    return await updatePreferences(parsedInput);
  });

export const saveKiroApiKeyAction = authActionClient
  .inputSchema(z.object({ apiKey: z.string().min(1) }))
  .action(async ({ parsedInput, ctx }) => {
    try {
      sanitizeUserId(ctx.userId);
      await putKiroApiKey(ctx.userId, parsedInput.apiKey);
      return { success: true };
    } catch (error) {
      console.error('Error saving Kiro API key:', error);
      throw new Error('Failed to save Kiro API key');
    }
  });

export const deleteKiroApiKeyAction = authActionClient.inputSchema(z.object({})).action(async ({ ctx }) => {
  try {
    sanitizeUserId(ctx.userId);
    await deleteKiroApiKey(ctx.userId);
    return { success: true };
  } catch (error) {
    console.error('Error deleting Kiro API key:', error);
    throw new Error('Failed to delete Kiro API key');
  }
});

export const checkKiroApiKeyAction = authActionClient.inputSchema(z.object({})).action(async ({ ctx }) => {
  try {
    sanitizeUserId(ctx.userId);
    const key = await getKiroApiKey(ctx.userId);
    return { hasKey: key !== undefined };
  } catch (error) {
    console.error('Error checking Kiro API key:', error);
    throw new Error('Failed to check Kiro API key');
  }
});

export const updateUserPreferencesAction = authActionClient
  .inputSchema(updateUserPreferencesSchema)
  .action(async ({ parsedInput, ctx }) => {
    const input = { ...parsedInput };
    if ('kiroModel' in input && !input.kiroModel) {
      input.kiroModel = 'auto';
    }
    if ('kiroDefaultModel' in input && !input.kiroDefaultModel) {
      input.kiroDefaultModel = 'auto' as any;
    }
    // Keep legacy fields in sync with new fields
    if (input.kiroDefaultModel) {
      input.kiroModel = input.kiroDefaultModel as string;
    }
    return await updateUserPreferences(ctx.userId, input);
  });

export const getUserPreferencesAction = authActionClient.inputSchema(z.object({})).action(async ({ ctx }) => {
  return await getUserPreferences(ctx.userId);
});
