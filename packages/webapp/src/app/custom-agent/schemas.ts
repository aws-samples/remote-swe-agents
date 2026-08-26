import { z } from 'zod';
import {
  inferenceModeSchema,
  kiroModelSchema,
  mcpConfigSchema,
  modelTypeSchema,
} from '@remote-swe-agents/agent-core/schema';

export const upsertCustomAgentSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'Agent name is required').max(100, 'Agent name must be less than 100 characters'),
  description: z.string().default(''),
  defaultModel: modelTypeSchema,
  bedrockDefaultModel: modelTypeSchema.optional(),
  kiroDefaultModel: kiroModelSchema.optional(),
  systemPrompt: z.string().default(''),
  tools: z.array(z.string()),
  useAllTools: z.boolean().optional().default(false),
  mcpConfig: z
    .string()
    .optional()
    .default('')
    .refine((val) => {
      if (val === '') return true;
      try {
        const json = JSON.parse(val);
        mcpConfigSchema.parse(json);
        return true;
      } catch (e) {
        return false;
      }
    }, 'Invalid mcpConfig schema.'),
  runtimeType: z.union([z.literal('ec2'), z.literal('agent-core')]),
  iconKey: z.string().optional().default(''),
  includeDefaultKnowledge: z.boolean().optional().default(true),
  inferenceMode: inferenceModeSchema.nullable().optional(),
  kiroModel: z.string().optional(),
  parentAgentId: z.string().optional(),
});

export const deleteCustomAgentSchema = z.object({
  id: z.string().min(1, 'Agent ID is required'),
  // When true, the server action redirects to the custom-agent list after a
  // successful delete. The destination is decided server-side (a hardcoded
  // path) — this is a boolean flag, never a client-supplied path, to avoid
  // open-redirect. Used by the detail page (which owns the deleted route) to
  // avoid the revalidate/notFound 404 race.
  redirectToListOnSuccess: z.boolean().optional().default(false),
});

export const duplicateCustomAgentSchema = z.object({
  id: z.string().min(1, 'Agent ID is required'),
});
