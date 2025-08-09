'use server';

import { authActionClient } from '@/lib/safe-action';
import { savePromptSchema, modelConfigSchema } from './schemas';
import { writeCommonPrompt } from '@remote-swe-agents/agent-core/lib';
import { getModelConfig, setModelConfig } from '@remote-swe-agents/agent-core/aws';

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

export const getModelSettingAction = authActionClient.action(async () => {
  try {
    const modelId = await getModelConfig();
    return { modelId };
  } catch (error) {
    console.error('Failed to get model settings:', error);
    return { error: 'Failed to get model settings' };
  }
});

export const saveModelSettingAction = authActionClient.schema(modelConfigSchema).action(async ({ parsedInput }) => {
  try {
    await setModelConfig(parsedInput.modelId);
    return { success: true };
  } catch (error) {
    console.error('Failed to save model settings:', error);
    return { error: { serverError: 'Failed to save model settings' }, success: false };
  }
});
