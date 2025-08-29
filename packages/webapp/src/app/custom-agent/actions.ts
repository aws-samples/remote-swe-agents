'use server';

import { authActionClient } from '@/lib/safe-action';
import { upsertCustomAgentSchema } from './schemas';
import { createCustomAgent, updateCustomAgent } from '@remote-swe-agents/agent-core/lib';
import { revalidatePath } from 'next/cache';

export const upsertCustomAgentAction = authActionClient
  .inputSchema(upsertCustomAgentSchema)
  .action(async ({ parsedInput }) => {
    try {
      const { id, ...agentData } = parsedInput;

      let agent;
      if (id) {
        // Update existing agent
        agent = await updateCustomAgent(id, agentData);
      } else {
        // Create new agent
        agent = await createCustomAgent(agentData);
      }

      revalidatePath('/custom-agent');
      return { success: true, agent };
    } catch (error) {
      console.error('Error upserting custom agent:', error);
      throw new Error('Failed to save custom agent');
    }
  });
