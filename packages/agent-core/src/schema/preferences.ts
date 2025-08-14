import { z } from 'zod';
import { modelTypeSchema } from './model';

export const globalPreferenceSchema = z.object({
  PK: z.literal('global-config'),
  SK: z.literal('general'),
  modelOverride: modelTypeSchema.default('sonnet3.7'),
  updatedAt: z.number(),
});

export const updateGlobalPreferenceSchema = globalPreferenceSchema
  .omit({
    PK: true,
    SK: true,
    updatedAt: true,
  })
  .partial();

export type GlobalPreference = z.infer<typeof globalPreferenceSchema>;
