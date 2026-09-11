import { describe, expect, test, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sendSystemMessage: vi.fn(async () => undefined),
  saveConversationHistory: vi.fn(async () => ({
    PK: 'message-w1',
    SK: '001785840964706',
    content: '[]',
    role: 'assistant',
    tokenCount: 0,
    messageType: 'assistant',
  })),
  notifyTermination: vi.fn(async () => undefined),
  updateAgentStatusWithEvent: vi.fn(async () => undefined),
}));

// Keep the import light + side-effect free: the heavy teardown deps are only
// used inside exit(), which these tests do not call.
vi.mock('../agent/mcp', () => ({ closeMcpServers: vi.fn(async () => undefined) }));
vi.mock('../agent/backends', () => ({ disposeAllBackends: vi.fn(async () => undefined) }));
vi.mock('@remote-swe-agents/agent-core/lib', async () => {
  const actual = await vi.importActual<typeof import('@remote-swe-agents/agent-core/lib')>(
    '@remote-swe-agents/agent-core/lib'
  );
  return {
    ...actual,
    getSession: mocks.getSession,
    sendSystemMessage: mocks.sendSystemMessage,
    saveConversationHistory: mocks.saveConversationHistory,
  };
});
vi.mock('./notify-termination', () => ({ notifyTermination: mocks.notifyTermination }));
vi.mock('./status', () => ({ updateAgentStatusWithEvent: mocks.updateAgentStatusWithEvent }));

const { setActiveWorkerId, notifyTerminationIfActiveTurn } = await import('./signal-handler');

describe('signal-handler: notifyTerminationIfActiveTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveWorkerId('w1');
  });

  test('killed mid-turn (agentStatus=working) → sends feedback, updates status, notifies parent', async () => {
    mocks.getSession.mockResolvedValue({ workerId: 'w1', agentStatus: 'working', parentSessionId: 'p1' });
    await notifyTerminationIfActiveTurn('SIGTERM');
    expect(mocks.saveConversationHistory).toHaveBeenCalledTimes(1);
    expect(mocks.saveConversationHistory).toHaveBeenCalledWith(
      'w1',
      { role: 'assistant', content: [{ text: 'Agent work was stopped.' }] },
      0,
      'assistant'
    );
    expect(mocks.sendSystemMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith(
      'w1',
      'Agent work was stopped.',
      false,
      false,
      '001785840964706'
    );
    expect(mocks.updateAgentStatusWithEvent).toHaveBeenCalledTimes(1);
    expect(mocks.updateAgentStatusWithEvent).toHaveBeenCalledWith('w1', 'pending');
    expect(mocks.notifyTermination).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTermination).toHaveBeenCalledWith('w1', 'error', expect.stringContaining('SIGTERM'));
  });

  test('idle session (agentStatus=pending) → does NOT notify (avoids false [Child error])', async () => {
    mocks.getSession.mockResolvedValue({ workerId: 'w1', agentStatus: 'pending' });
    await notifyTerminationIfActiveTurn('SIGTERM');
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    expect(mocks.updateAgentStatusWithEvent).not.toHaveBeenCalled();
    expect(mocks.notifyTermination).not.toHaveBeenCalled();
  });

  test('no activeWorkerId → does nothing', async () => {
    setActiveWorkerId(undefined as any);
    await notifyTerminationIfActiveTurn('SIGTERM');
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    expect(mocks.updateAgentStatusWithEvent).not.toHaveBeenCalled();
    expect(mocks.notifyTermination).not.toHaveBeenCalled();
  });

  test('feedback and status update happen before parent notification', async () => {
    const callOrder: string[] = [];
    mocks.getSession.mockResolvedValue({ workerId: 'w1', agentStatus: 'working', parentSessionId: 'p1' });
    mocks.saveConversationHistory.mockImplementation(async () => {
      callOrder.push('saveConversationHistory');
      return {
        PK: 'message-w1' as const,
        SK: '001785840964706',
        content: '[]',
        role: 'assistant',
        tokenCount: 0,
        messageType: 'assistant',
      };
    });
    mocks.sendSystemMessage.mockImplementation(async () => {
      callOrder.push('sendSystemMessage');
    });
    mocks.updateAgentStatusWithEvent.mockImplementation(async () => {
      callOrder.push('updateAgentStatusWithEvent');
    });
    mocks.notifyTermination.mockImplementation(async () => {
      callOrder.push('notifyTermination');
    });
    await notifyTerminationIfActiveTurn('SIGTERM');
    expect(callOrder).toEqual([
      'saveConversationHistory',
      'sendSystemMessage',
      'updateAgentStatusWithEvent',
      'notifyTermination',
    ]);
  });

  test('getSession failure is caught and logged (no throw)', async () => {
    mocks.getSession.mockRejectedValue(new Error('DDB timeout'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(notifyTerminationIfActiveTurn('SIGTERM')).resolves.toBeUndefined();
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    expect(mocks.notifyTermination).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('sendSystemMessage failure does NOT prevent updateAgentStatusWithEvent or notifyTermination', async () => {
    mocks.getSession.mockResolvedValue({ workerId: 'w1', agentStatus: 'working', parentSessionId: 'p1' });
    mocks.sendSystemMessage.mockRejectedValue(new Error('DDB throttle'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await notifyTerminationIfActiveTurn('SIGTERM');
    expect(mocks.saveConversationHistory).toHaveBeenCalledTimes(1);
    expect(mocks.updateAgentStatusWithEvent).toHaveBeenCalledTimes(1);
    expect(mocks.updateAgentStatusWithEvent).toHaveBeenCalledWith('w1', 'pending');
    expect(mocks.notifyTermination).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTermination).toHaveBeenCalledWith('w1', 'error', expect.stringContaining('SIGTERM'));
    spy.mockRestore();
  });

  test('saveConversationHistory failure does NOT prevent sendSystemMessage or other steps', async () => {
    mocks.getSession.mockResolvedValue({ workerId: 'w1', agentStatus: 'working', parentSessionId: 'p1' });
    mocks.saveConversationHistory.mockRejectedValue(new Error('DDB capacity'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await notifyTerminationIfActiveTurn('SIGTERM');
    expect(mocks.sendSystemMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', 'Agent work was stopped.', false, false, undefined);
    expect(mocks.updateAgentStatusWithEvent).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTermination).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('updateAgentStatusWithEvent failure does NOT prevent notifyTermination', async () => {
    mocks.getSession.mockResolvedValue({ workerId: 'w1', agentStatus: 'working', parentSessionId: 'p1' });
    mocks.updateAgentStatusWithEvent.mockRejectedValue(new Error('DDB error'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await notifyTerminationIfActiveTurn('SIGTERM');
    expect(mocks.sendSystemMessage).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTermination).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('notifyTermination failure does NOT throw (all steps are independently caught)', async () => {
    mocks.getSession.mockResolvedValue({ workerId: 'w1', agentStatus: 'working', parentSessionId: 'p1' });
    mocks.notifyTermination.mockRejectedValue(new Error('network error'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(notifyTerminationIfActiveTurn('SIGTERM')).resolves.toBeUndefined();
    expect(mocks.sendSystemMessage).toHaveBeenCalledTimes(1);
    expect(mocks.updateAgentStatusWithEvent).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
