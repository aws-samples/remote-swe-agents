'use server';

import { authActionClient } from '@/lib/safe-action';
import { savePromptSchema } from './schemas';
import { writeCommonPrompt, updatePreferences } from '@remote-swe-agents/agent-core/lib';
import { updateGlobalPreferenceSchema } from '@remote-swe-agents/agent-core/schema';

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
    await updatePreferences(parsedInput);
  });
