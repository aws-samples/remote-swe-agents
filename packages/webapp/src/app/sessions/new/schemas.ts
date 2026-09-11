import { inferenceModeSchema, kiroModelSchema, modelTypeSchema } from '@remote-swe-agents/agent-core/schema';
import { z } from 'zod';

// Treat empty strings as "not set" for optional enum fields. Form state can
// end up with "" (e.g. after a reset), which would otherwise fail enum
// validation invisibly and leave the submit button disabled with no error.
//
// The trailing `.optional()` wraps the ZodEffects in a ZodOptional so the
// field's INPUT type is optional (`field?: unknown`) rather than a required
// `field: unknown`. Without it, react-hook-form's 3-generic Control renders
// the input type (required `unknown`) as incompatible with the resolver's
// OUTPUT type (optional enum), producing the "Property is optional in ... but
// required in ..." TS2322 on every `control={control}` FormField. Runtime
// behaviour is unchanged: `''` → preprocess → undefined; `undefined` short-
// circuits through the outer ZodOptional.
const optionalEnum = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional()).optional();

export const createNewWorkerSchema = z.object({
  message: z.string().min(1),
  imageKeys: z.array(z.string()).optional(),
  fileKeys: z.array(z.string()).optional(),
  modelOverride: optionalEnum(modelTypeSchema),
  customAgentId: z.string().optional(),
  inferenceMode: optionalEnum(inferenceModeSchema),
  kiroModel: z.string().optional(),
  bedrockDefaultModel: optionalEnum(modelTypeSchema),
  kiroDefaultModel: optionalEnum(kiroModelSchema),
});

export const promptTemplateSchema = z.object({
  PK: z.literal('prompt-template'),
  SK: z.string(),
  content: z.string(),
  createdAt: z.number(),
});

export type PromptTemplate = z.infer<typeof promptTemplateSchema>;
