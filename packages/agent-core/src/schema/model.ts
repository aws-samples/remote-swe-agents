import { z } from 'zod';

export const modelTypeSchema = z.enum([
  'sonnet3.5v1',
  'sonnet3.5',
  'sonnet3.7',
  'haiku3.5',
  'nova-pro',
  'opus4',
  'opus4.1',
  'sonnet4',
]);
export type ModelType = z.infer<typeof modelTypeSchema>;
