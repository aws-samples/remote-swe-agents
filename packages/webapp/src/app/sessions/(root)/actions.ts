'use server';

import { updateSessionVisibility } from '@remote-swe-agents/agent-core/lib';
import { authActionClient } from '@/lib/safe-action';
import { z } from 'zod';

const hideSessionSchema = z.object({
  workerId: z.string(),
});

export const hideSessionAction = authActionClient
  .schema(hideSessionSchema)
  .action(async ({ parsedInput: { workerId } }) => {
    await updateSessionVisibility(workerId, true);
    return { success: true };
  });
