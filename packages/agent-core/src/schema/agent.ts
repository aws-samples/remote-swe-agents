import { z } from 'zod';
import { modelTypeSchema } from './model';

export const agentStatusSchema = z.union([z.literal('working'), z.literal('pending'), z.literal('completed')]);

export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const customAgentSchema = z.object({
  PK: z.literal('custom-agent'),
  SK: z.string(),
  name: z.string(),
  description: z.string(),
  defaultModel: modelTypeSchema,
  systemPrompt: z.string(),
  tools: z.array(z.string()),
  mcpConfig: z.string(),
  runtimeType: z.union([z.literal('ec2'), z.literal('agent-core')]),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type CustomAgent = z.infer<typeof customAgentSchema>;
