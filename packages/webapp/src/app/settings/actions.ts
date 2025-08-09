'use server';

import { authActionClient } from '@/lib/safe-action';
import { modelConfigSchema } from './schemas';
import { setModelConfig, getModelConfig } from '@remote-swe-agents/agent-core/aws';

export const getModelSettingAction = authActionClient.action(async () => {
  try {
    const modelId = await getModelConfig();
    return { modelId };
  } catch (error) {
    console.error('Failed to get model settings:', error);
    return { error: 'Failed to get model settings' };
  }
});

export const saveModelSettingAction = authActionClient
  .schema(modelConfigSchema)
  .action(async ({ parsedInput }) => {
    try {
      await setModelConfig(parsedInput.modelId);
      return { success: true };
    } catch (error) {
      console.error('Failed to save model settings:', error);
      return { error: 'Failed to save model settings', success: false };
    }
  });