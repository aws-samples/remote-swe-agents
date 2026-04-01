import { NextResponse } from 'next/server';
import { getVapidPublicKey } from '@remote-swe-agents/agent-core/lib';

export async function GET() {
  const vapidPublicKey = await getVapidPublicKey();

  if (!vapidPublicKey) {
    return NextResponse.json({ error: 'Push notifications are not configured' }, { status: 503 });
  }

  return NextResponse.json({ vapidPublicKey });
}
