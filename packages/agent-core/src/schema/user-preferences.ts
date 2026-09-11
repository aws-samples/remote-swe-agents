import { z } from 'zod';
import { inferenceModeSchema, kiroModelSchema, modelTypeSchema } from './model';

export const userPreferencesSchema = z.object({
  PK: z.literal('user-preferences'),
  SK: z.string(),
  inferenceMode: inferenceModeSchema.optional(),
  kiroModel: z.string().optional(),
  bedrockDefaultModel: modelTypeSchema.optional(),
  kiroDefaultModel: kiroModelSchema.optional(),
  updatedAt: z.number().default(0),
});

export const updateUserPreferencesSchema = z.object({
  inferenceMode: inferenceModeSchema.optional(),
  kiroModel: z.string().optional(),
  bedrockDefaultModel: modelTypeSchema.optional(),
  kiroDefaultModel: kiroModelSchema.optional(),
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;
