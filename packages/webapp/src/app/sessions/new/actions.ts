'use server';

import { createNewWorkerSchema } from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { createSession } from '@remote-swe-agents/agent-core/lib';
import { redirect } from 'next/navigation';

export const createNewWorker = authActionClient
  .inputSchema(createNewWorkerSchema)
  .action(async ({ parsedInput, ctx }) => {
    if (process.env.SLACK_ONLY_SESSION_CREATION === 'true') {
      throw new Error('Session creation is only allowed from Slack.');
    }
    const { message, imageKeys = [], fileKeys = [], modelOverride, customAgentId = '' } = parsedInput;
    const { userId } = ctx;

    const workerId = await createSession({
      message,
      initiator: `webapp#${userId}`,
      customAgentId: customAgentId || undefined,
      modelOverride,
      imageKeys,
      fileKeys,
    });

    redirect(`/sessions/${workerId}`);
  });
