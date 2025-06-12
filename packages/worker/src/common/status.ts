import { updateSessionAgentStatus, sendWebappEvent } from '@remote-swe-agents/agent-core/lib';

/**
 * Updates the agent status and sends a corresponding webapp event
 */
export async function updateAgentStatusWithEvent(workerId: string, status: 'working' | 'pending'): Promise<void> {
  await updateSessionAgentStatus(workerId, status);
  await sendWebappEvent(workerId, {
    type: 'agentStatusUpdate',
    status,
  });
}
