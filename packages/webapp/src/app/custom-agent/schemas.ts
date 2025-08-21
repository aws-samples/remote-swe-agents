import { z } from 'zod';
import { modelTypeSchema } from '@remote-swe-agents/agent-core/schema';

export const createCustomAgentSchema = z.object({
  name: z.string().min(1, 'Agent name is required').max(100, 'Agent name must be less than 100 characters'),
  description: z.string().min(1, 'Agent description is required'),
  defaultModel: modelTypeSchema,
  systemPrompt: z.string().min(1, 'System prompt is required'),
  tools: z.array(z.string()),
  mcpConfig: z.string().optional().default(''),
  runtimeType: z.union([z.literal('ec2'), z.literal('agent-core')]),
});
