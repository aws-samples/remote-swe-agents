import { z } from 'zod';

export const runTranslateJobSchema = z.object({
  id: z.string().uuid(),
});
