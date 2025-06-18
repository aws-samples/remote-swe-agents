'use server';

import { authActionClient } from '@/lib/safe-action';
import { updateSessionTitle } from '@remote-swe-agents/agent-core/lib';
import { updateSessionTitleSchema } from '../schemas';

export const updateSessionTitleAction = authActionClient
  .schema(updateSessionTitleSchema)
  .action(async ({ parsedInput: { workerId, title } }) => {
    try {
      await updateSessionTitle(workerId, title);
      return { success: true };
    } catch (error) {
      console.error('Failed to update session title:', error);
      return { success: false, error: 'Failed to update session title' };
    }
  });
