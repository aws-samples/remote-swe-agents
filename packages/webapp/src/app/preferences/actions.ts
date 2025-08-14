'use server';

import { authActionClient } from '@/lib/safe-action';
import { savePromptSchema } from './schemas';
import { writeCommonPrompt } from '@remote-swe-agents/agent-core/lib';

// Create action using the safe-action client
export const savePromptAction = authActionClient.inputSchema(savePromptSchema).action(async ({ parsedInput }) => {
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
