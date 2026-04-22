import { z } from 'zod';
import { ModelType, modelTypeSchema } from './model';

export const agentStatusSchema = z.union([z.literal('working'), z.literal('pending'), z.literal('completed')]);
export const runtimeTypeSchema = z.union([z.literal('ec2'), z.literal('agent-core')]);
export const defaultRuntimeType: RuntimeType = 'agent-core';

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type RuntimeType = z.infer<typeof runtimeTypeSchema>;

/**
 * Default agent configuration values.
 * Used by createSession (when no custom agent is specified) and by the worker's DefaultAgent definition.
 * This is the single source of truth for default runtime type and model.
 */
export const defaultAgentConfig: { runtimeType: RuntimeType; defaultModel: ModelType } = {
  runtimeType: 'agent-core',
  defaultModel: 'sonnet4.6',
};

export const customAgentSchema = z.object({
  PK: z.literal('custom-agent'),
  SK: z.string(),
  name: z.string(),
  description: z.string(),
  defaultModel: modelTypeSchema,
  systemPrompt: z.string(),
  tools: z.array(z.string()),
  useAllTools: z.boolean().optional(),
  mcpConfig: z.string(),
  runtimeType: runtimeTypeSchema,
  iconKey: z.string().optional(),
  includeDefaultKnowledge: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type CustomAgent = z.infer<typeof customAgentSchema>;
