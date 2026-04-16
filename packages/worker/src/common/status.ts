import {
  updateSessionAgentStatus,
  sendWebappEvent,
  getSession,
  markPending,
  getConversationHistory,
} from '@remote-swe-agents/agent-core/lib';

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
        // For child sessions, only mark pending if the last incoming message was from a user.
        // This avoids unnecessary notifications when the child is just communicating with
        // its parent agent or responding to event triggers.
        if (session.parentSessionId) {
          const { items } = await getConversationHistory(workerId);
          const lastIncoming = items.filter((i) => i.role === 'user').at(-1);
          if (lastIncoming?.messageType !== 'userMessage') {
            return;
          }
        }

        const userId = session.initiator.replace('webapp#', '');
        await markPending(userId, workerId);
      }
    } catch (e) {
      console.error('[unread] Failed to mark pending:', e);
    }
  }
}
