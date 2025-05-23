'use server';

import { authActionClient } from '@/lib/safe-action';
import { runTranslateJobSchema } from './schemas';
import { runJob } from '@/lib/jobs';

export const runTranslateJob = authActionClient.schema(runTranslateJobSchema).action(async ({ parsedInput, ctx }) => {
  await runJob({
    type: 'example',
  });
});
