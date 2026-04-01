'use server';

import { createNewWorkerSchema } from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { createSession } from '@remote-swe-agents/agent-core/lib';
import { redirect } from 'next/navigation';

export const createNewWorker = authActionClient
  .inputSchema(createNewWorkerSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { message, customAgentId = '' } = parsedInput;
    const { userId } = ctx;

    const workerId = await createSession({
      message,
      initiator: `webapp#${userId}`,
      customAgentId: customAgentId || undefined,
    });

    redirect(`/sessions/${workerId}`);
  });
