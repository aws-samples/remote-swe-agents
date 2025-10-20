import { z } from 'zod';

export const modelTypeList = [
  'sonnet4.5',
  'haiku4.5',
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

const criRegionSchema = z.enum(['global', 'us', 'eu', 'apac', 'jp', 'au']);
export const criRegion = criRegionSchema
  .catch('us')
  .parse(process.env.NEXT_PUBLIC_BEDROCK_CRI_REGION_OVERRIDE || process.env.BEDROCK_CRI_REGION_OVERRIDE || 'us');

const modelConfigSchema = z.object({
  name: z.string(),
  modelId: z.string(),
  maxOutputTokens: z.number(),
  maxInputTokens: z.number(),
  cacheSupport: z.array(z.enum(['system', 'tool', 'message'])),
  reasoningSupport: z.boolean(),
  toolChoiceSupport: z.array(z.enum(['any', 'auto', 'tool'])),
  isHidden: z.boolean().optional(),
  interleavedThinkingSupport: z.boolean().optional(),
  supportedCriProfiles: z.array(criRegionSchema),
  pricing: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
});

export const modelConfigs: Record<ModelType, z.infer<typeof modelConfigSchema>> = {
  'sonnet4.5': {
    name: 'Claude 4.5 Sonnet',
    modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['global', 'us', 'eu', 'jp', 'au'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
  'haiku4.5': {
    name: 'Claude 4.5 Haiku',
    modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['global', 'us', 'eu', 'jp', 'au'],
    pricing: { input: 0.001, output: 0.005, cacheRead: 0.0001, cacheWrite: 0.00125 },
  },
  'sonnet3.5v1': {
    name: 'Claude 3.5 Sonnet v1',
    modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    maxOutputTokens: 4096,
    maxInputTokens: 200_000,
    cacheSupport: [],
    reasoningSupport: false,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    isHidden: true,
    supportedCriProfiles: ['us', 'apac'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
  'sonnet3.5': {
    name: 'Claude 3.5 Sonnet v2',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    maxOutputTokens: 4096,
    maxInputTokens: 200_000,
    cacheSupport: [],
    reasoningSupport: false,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    supportedCriProfiles: ['us', 'apac'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
  'sonnet3.7': {
    name: 'Claude 3.7 Sonnet',
    modelId: 'anthropic.claude-3-7-sonnet-20250219-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    supportedCriProfiles: ['us', 'eu', 'apac'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
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
    supportedCriProfiles: ['us', 'eu'],
    pricing: { input: 0.0008, output: 0.004, cacheRead: 0.00008, cacheWrite: 0.001 },
  },
  'nova-pro': {
    name: 'Amazon Nova Pro',
    modelId: 'amazon.nova-pro-v1:0',
    maxOutputTokens: 10_000,
    maxInputTokens: 300_000,
    reasoningSupport: false,
    cacheSupport: ['system'],
    toolChoiceSupport: ['auto'],
    supportedCriProfiles: ['us', 'apac'],
    pricing: { input: 0.0008, output: 0.0032, cacheRead: 0.0002, cacheWrite: 0.0008 },
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
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['us'],
    pricing: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 },
  },
  'opus4.1': {
    name: 'Claude 4.1 Opus',
    modelId: 'anthropic.claude-opus-4-1-20250805-v1:0',
    maxOutputTokens: 32_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['us'],
    pricing: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 },
  },
  sonnet4: {
    name: 'Claude 4 Sonnet',
    modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['global', 'us', 'eu', 'apac'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
};

export const getAvailableModelTypes = (): ModelType[] => {
  return Object.entries(modelConfigs)
    .filter(([_, config]) => !config.isHidden && config.supportedCriProfiles.includes(criRegion))
    .map(([type, _]) => type as ModelType);
};
