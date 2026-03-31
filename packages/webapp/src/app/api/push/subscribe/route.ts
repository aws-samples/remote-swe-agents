import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { savePushSubscription } from '@remote-swe-agents/agent-core/lib';
import { z } from 'zod';

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});

export async function POST(request: NextRequest) {
  try {
    const { userId } = await getSession();
    const body = await request.json();
    const parsed = subscriptionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid subscription data' }, { status: 400 });
    }

    await savePushSubscription(userId, parsed.data);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to save push subscription:', error);
    return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 });
  }
}
