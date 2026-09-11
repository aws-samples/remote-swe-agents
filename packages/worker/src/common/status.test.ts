import { describe, expect, test, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateSessionAgentStatus: vi.fn(async () => undefined),
  sendWebappEvent: vi.fn(async () => undefined),
  getSession: vi.fn(async () => undefined as any),
  markPending: vi.fn(async () => undefined),
  getConversationHistory: vi.fn(async () => ({ items: [] })),
}));

vi.mock('@remote-swe-agents/agent-core/lib', () => mocks);

import { updateAgentStatusWithEvent } from './status';

describe('updateAgentStatusWithEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('working status updates agentStatus and sends event', async () => {
    await updateAgentStatusWithEvent('worker-1', 'working');

    expect(mocks.updateSessionAgentStatus).toHaveBeenCalledWith('worker-1', 'working');
    expect(mocks.sendWebappEvent).toHaveBeenCalledWith('worker-1', { type: 'agentStatusUpdate', status: 'working' });
  });

  test('pending status updates agentStatus and sends event', async () => {
    mocks.getSession.mockResolvedValue({ initiator: 'slack#123' });

    await updateAgentStatusWithEvent('worker-1', 'pending');

    expect(mocks.updateSessionAgentStatus).toHaveBeenCalledWith('worker-1', 'pending');
    expect(mocks.sendWebappEvent).toHaveBeenCalledWith('worker-1', { type: 'agentStatusUpdate', status: 'pending' });
  });
});
