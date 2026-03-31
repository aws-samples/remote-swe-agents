'use server';

import { authActionClient } from '@/lib/safe-action';
import { getUnreadSummary } from '@remote-swe-agents/agent-core/lib';
import { z } from 'zod';

export const getUnreadBadgeInfo = authActionClient.inputSchema(z.object({})).action(async ({ ctx }) => {
  const summary = await getUnreadSummary(ctx.userId);
  return { badge: summary };
});
