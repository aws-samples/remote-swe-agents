import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { deletePushSubscription } from '@remote-swe-agents/agent-core/lib';
import { z } from 'zod';

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

export async function POST(request: NextRequest) {
  try {
    const { userId } = await getSession();
    const body = await request.json();
    const parsed = unsubscribeSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    }

    await deletePushSubscription(userId, parsed.data.endpoint);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete push subscription:', error);
    return NextResponse.json({ error: 'Failed to unsubscribe' }, { status: 500 });
  }
}
