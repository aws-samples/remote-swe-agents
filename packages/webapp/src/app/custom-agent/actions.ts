'use server';

import { authActionClient } from '@/lib/safe-action';
import { upsertCustomAgentSchema, deleteCustomAgentSchema, duplicateCustomAgentSchema } from './schemas';
import {
  createCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
  getCustomAgent,
  getCustomAgents,
} from '@remote-swe-agents/agent-core/lib';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

const AGENT_NAME_MAX_LENGTH = 100;

export const upsertCustomAgentAction = authActionClient
  .inputSchema(upsertCustomAgentSchema)
  .action(async ({ parsedInput }) => {
    try {
      const { id, ...agentData } = parsedInput;
      agentData.mcpConfig = JSON.stringify(JSON.parse(agentData.mcpConfig)); // minify

      let agent;
      if (id) {
        // Update existing agent. inferenceMode === null removes the attribute
        // (back to "inherit from Preferences").
        agent = await updateCustomAgent(id, agentData);
      } else {
        // Create new agent
        const { inferenceMode, ...rest } = agentData;
        agent = await createCustomAgent(inferenceMode === null ? rest : { ...rest, inferenceMode });
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
    const { id, redirectToListOnSuccess } = parsedInput;
    let deletedCount: number;
    try {
      // Cascade delete: also remove all descendant sub-agents so they cannot
      // become invisible orphans (the list page shows top-level agents only).
      // Delete leaves first so a partial failure never leaves children behind
      // without their parent.
      const allAgents = await getCustomAgents();
      const idsToDelete = [id];
      for (let i = 0; i < idsToDelete.length; i++) {
        const parentId = idsToDelete[i];
        for (const agent of allAgents) {
          if (agent.parentAgentId === parentId && !idsToDelete.includes(agent.SK)) {
            idsToDelete.push(agent.SK);
          }
        }
      }
      for (const agentId of idsToDelete.reverse()) {
        await deleteCustomAgent(agentId);
      }

      revalidatePath('/custom-agent');
      deletedCount = idsToDelete.length;
    } catch (error) {
      console.error('Error deleting custom agent:', error);
      throw new Error('Failed to delete custom agent');
    }

    // Redirect outside the try/catch so the NEXT_REDIRECT signal thrown by
    // redirect() is not swallowed by the catch above. When deleting the agent
    // that owns the current route (detail page), a client-side navigation would
    // race the server revalidation of that same route and could flash a 404
    // (getCustomAgent returns null -> notFound()). A server redirect wins the
    // race deterministically. The list page reads ?deleted=1 to show the
    // deleteSuccess toast, since redirect() prevents the client onSuccess.
    if (redirectToListOnSuccess) {
      redirect('/custom-agent?deleted=1');
    }

    return { success: true, deletedCount };
  });

export const duplicateCustomAgentAction = authActionClient
  .inputSchema(duplicateCustomAgentSchema)
  .action(async ({ parsedInput }) => {
    try {
      const { id } = parsedInput;
      const source = await getCustomAgent(id);
      if (!source) {
        throw new Error('Agent not found');
      }
      const t = await getTranslations('customAgent');
      const suffix = t('copySuffix');
      const baseName = source.name.slice(0, AGENT_NAME_MAX_LENGTH - suffix.length - 1);
      const { PK, SK, createdAt, updatedAt, ...fields } = source;
      const agent = await createCustomAgent({
        ...fields,
        name: `${baseName} ${suffix}`,
      });

      revalidatePath('/custom-agent');
      return { success: true, agent };
    } catch (error) {
      console.error('Error duplicating custom agent:', error);
      throw new Error('Failed to duplicate custom agent');
    }
  });
