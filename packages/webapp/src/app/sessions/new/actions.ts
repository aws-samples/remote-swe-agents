'use server';

import { createNewWorkerSchema } from './schemas';
import { authActionClient } from '@/lib/safe-action';
import { createSession } from '@remote-swe-agents/agent-core/lib';
import { redirect } from 'next/navigation';

export const createNewWorker = authActionClient
  .inputSchema(createNewWorkerSchema)
  .action(async ({ parsedInput, ctx }) => {
    const {
      message,
      imageKeys = [],
      fileKeys = [],
      modelOverride,
      customAgentId = '',
      inferenceMode,
      kiroModel,
      bedrockDefaultModel,
      kiroDefaultModel,
    } = parsedInput;
    const { userId } = ctx;

    const effectiveBedrockDefault = bedrockDefaultModel ?? modelOverride;
    const workerId = await createSession({
      message,
      initiator: `webapp#${userId}`,
      customAgentId: customAgentId || undefined,
      imageKeys,
      fileKeys,
      inferenceMode,
      kiroModel: kiroDefaultModel ?? kiroModel,
      bedrockDefaultModel: effectiveBedrockDefault,
      kiroDefaultModel,
    });

    redirect(`/sessions/${workerId}`);
  });
