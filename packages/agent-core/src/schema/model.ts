import { z } from 'zod';

export const modelTypeList = [
  'sonnet4',
  'opus4.1',
  'opus4',
  'sonnet3.7',
  'sonnet3.5',
  'sonnet3.5v1',
  'haiku3.5',
  'nova-pro',
] as const;
export const modelTypeSchema = z.enum(modelTypeList);
export type ModelType = z.infer<typeof modelTypeSchema>;

const modelConfigSchema = z.object({
  name: z.string(),
  modelId: z.string(),
  maxOutputTokens: z.number(),
  maxInputTokens: z.number(),
  cacheSupport: z.array(z.enum(['system', 'tool', 'message'])),
  reasoningSupport: z.boolean(),
  toolChoiceSupport: z.array(z.enum(['any', 'auto', 'tool'])),
  isHidden: z.boolean().optional(),
});

export const modelConfigs: Record<ModelType, z.infer<typeof modelConfigSchema>> = {
  'sonnet3.5v1': {
    name: 'Claude 3.5 Sonnet v1',
    modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    maxOutputTokens: 4096,
    maxInputTokens: 200_000,
    cacheSupport: [],
    reasoningSupport: false,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    isHidden: true,
  },
  'sonnet3.5': {
    name: 'Claude 3.5 Sonnet v2',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    maxOutputTokens: 4096,
    maxInputTokens: 200_000,
    cacheSupport: [],
    reasoningSupport: false,
    toolChoiceSupport: ['any', 'auto', 'tool'],
  },
  'sonnet3.7': {
    name: 'Claude 3.7 Sonnet',
    modelId: 'anthropic.claude-3-7-sonnet-20250219-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
  },
  'haiku3.5': {
    name: 'Claude 3.5 Haiku',
    modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
    maxOutputTokens: 4096,
    maxInputTokens: 200_000,
    cacheSupport: [],
    reasoningSupport: false,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    isHidden: true,
  },
  'nova-pro': {
    name: 'Amazon Nova Pro',
    modelId: 'amazon.nova-pro-v1:0',
    maxOutputTokens: 10_000,
    maxInputTokens: 300_000,
    reasoningSupport: false,
    cacheSupport: ['system'],
    toolChoiceSupport: ['auto'],
  },
  opus4: {
    name: 'Claude 4 Opus',
    modelId: 'anthropic.claude-opus-4-20250514-v1:0',
    maxOutputTokens: 32_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    isHidden: true,
  },
  'opus4.1': {
    name: 'Claude 4.1 Opus',
    modelId: 'anthropic.claude-opus-4-1-20250805-v1:0',
    maxOutputTokens: 32_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
  },
  sonnet4: {
    name: 'Claude 4 Sonnet',
    modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
  },
};
