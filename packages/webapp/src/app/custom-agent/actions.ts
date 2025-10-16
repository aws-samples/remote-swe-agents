'use server';

import { authActionClient } from '@/lib/safe-action';
import { upsertCustomAgentSchema, deleteCustomAgentSchema } from './schemas';
import { createCustomAgent, updateCustomAgent, deleteCustomAgent } from '@remote-swe-agents/agent-core/lib';
import { revalidatePath } from 'next/cache';

export const upsertCustomAgentAction = authActionClient
  .inputSchema(upsertCustomAgentSchema)
  .action(async ({ parsedInput }) => {
    try {
      const { id, ...agentData } = parsedInput;
      agentData.mcpConfig = JSON.stringify(JSON.parse(agentData.mcpConfig)); // minify

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

export const deleteCustomAgentAction = authActionClient
  .inputSchema(deleteCustomAgentSchema)
  .action(async ({ parsedInput }) => {
    try {
      const { id } = parsedInput;
      await deleteCustomAgent(id);

      revalidatePath('/custom-agent');
      return { success: true };
    } catch (error) {
      console.error('Error deleting custom agent:', error);
      throw new Error('Failed to delete custom agent');
    }
  });
