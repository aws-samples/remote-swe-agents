'use server';

import { authActionClient } from '@/lib/safe-action';
import { getUnreadSummary, getUnreadSessionDetails, markAllSessionsRead } from '@remote-swe-agents/agent-core/lib';
import { z } from 'zod';

export const getUnreadBadgeInfo = authActionClient.inputSchema(z.object({})).action(async ({ ctx }) => {
  const summary = await getUnreadSummary(ctx.userId);
  return { badge: summary };
});

export const getUnreadSessionDetailsAction = authActionClient.inputSchema(z.object({})).action(async ({ ctx }) => {
  const details = await getUnreadSessionDetails(ctx.userId);
  return { sessions: details };
});

export const markAllReadAction = authActionClient.inputSchema(z.object({})).action(async ({ ctx }) => {
  await markAllSessionsRead(ctx.userId);
  const summary = await getUnreadSummary(ctx.userId);
  return { badge: summary };
});
