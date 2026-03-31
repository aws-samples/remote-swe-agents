import { updateSessionAgentStatus, sendWebappEvent, getSession, markPending } from '@remote-swe-agents/agent-core/lib';

/**
 * Updates the agent status and sends a corresponding webapp event
 */
export async function updateAgentStatusWithEvent(workerId: string, status: 'working' | 'pending'): Promise<void> {
  await updateSessionAgentStatus(workerId, status);
  await sendWebappEvent(workerId, {
    type: 'agentStatusUpdate',
    status,
  });

  if (status === 'pending') {
    try {
      const session = await getSession(workerId);
      if (session?.initiator?.startsWith('webapp#')) {
        const userId = session.initiator.replace('webapp#', '');
        await markPending(userId, workerId);
      }
    } catch (e) {
      console.error('[unread] Failed to mark pending:', e);
    }
  }
}
