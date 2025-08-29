'use server';

import { authActionClient } from '@/lib/safe-action';
import { createCustomAgentSchema } from './schemas';
import { createCustomAgent } from '@remote-swe-agents/agent-core/lib';

export const createCustomAgentAction = authActionClient
  .inputSchema(createCustomAgentSchema)
  .action(async ({ parsedInput }) => {
    try {
      // Here you would save to your database
      const customAgent = await createCustomAgent({
        ...parsedInput,
      });

      return { success: true, agent: customAgent };
    } catch (error) {
      console.error('Error creating custom agent:', error);
      throw new Error('Failed to create custom agent');
    }
  });
