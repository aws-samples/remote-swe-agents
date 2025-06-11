import { NextRequest, NextResponse } from 'next/server';
import { updateSessionAgentStatus } from '@remote-swe-agents/agent-core/lib';
import { isAgentStatus } from '@remote-swe-agents/agent-core/schema/agent';

export async function PUT(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const workerId = searchParams.get('workerId');

    if (!workerId) {
      return NextResponse.json({ error: 'Missing workerId parameter' }, { status: 400 });
    }

    const body = await request.json();

    if (!body.status || !isAgentStatus(body.status)) {
      return NextResponse.json(
        { error: 'Invalid status. Must be one of: working, pending response, completed' },
        { status: 400 }
      );
    }

    await updateSessionAgentStatus(workerId, body.status);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating session status:', error);
    return NextResponse.json({ error: 'Failed to update session status' }, { status: 500 });
  }
}
