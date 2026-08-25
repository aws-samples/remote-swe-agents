import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';

const mockGetSession = vi.fn();
const mockUpdateSessionAgentStatus = vi.fn();
const mockStopWorkerInstance = vi.fn();
const mockSendWebappEvent = vi.fn();

vi.mock('../../lib', () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
  updateSessionAgentStatus: (...args: any[]) => mockUpdateSessionAgentStatus(...args),
  stopWorkerInstance: (...args: any[]) => mockStopWorkerInstance(...args),
}));

vi.mock('../../lib/events', () => ({
  sendWebappEvent: (...args: any[]) => mockSendWebappEvent(...args),
}));

import { confirmCompleteSessionTool, savePendingCompleteSession } from './index';

const mockContext = {
  workerId: 'test-worker-confirm-123',
  toolUseId: 'test-tool-use',
  globalPreferences: { PK: 'global-config', SK: 'general' },
};

describe('confirmCompleteSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      unlinkSync(join(tmpdir(), `.pending-complete-session-${mockContext.workerId}`));
    } catch {}
  });

  test('completes session when pending flag exists', async () => {
    savePendingCompleteSession(mockContext.workerId);
    mockGetSession.mockResolvedValue({ agentStatus: 'working', runtimeType: 'agent-core' });

    const result = await confirmCompleteSessionTool.handler({}, mockContext as any);

    expect(mockUpdateSessionAgentStatus).toHaveBeenCalledWith('test-worker-confirm-123', 'completed');
    expect(mockSendWebappEvent).toHaveBeenCalledWith('test-worker-confirm-123', {
      type: 'agentStatusUpdate',
      status: 'completed',
    });
    expect(mockStopWorkerInstance).toHaveBeenCalledWith('test-worker-confirm-123', 'agent-core');
    expect(result).toContain('completed');
  });

  test('falls back to ec2 runtime when runtimeType is undefined', async () => {
    savePendingCompleteSession(mockContext.workerId);
    mockGetSession.mockResolvedValue({ agentStatus: 'working' });

    const result = await confirmCompleteSessionTool.handler({}, mockContext as any);

    expect(mockStopWorkerInstance).toHaveBeenCalledWith('test-worker-confirm-123', 'ec2');
    expect(result).toContain('completed');
  });

  test('returns error when no pending completeSession exists', async () => {
    const result = await confirmCompleteSessionTool.handler({}, mockContext as any);

    expect(mockUpdateSessionAgentStatus).not.toHaveBeenCalled();
    expect(mockStopWorkerInstance).not.toHaveBeenCalled();
    expect(result).toContain('No pending completeSession');
  });

  test('returns error when session not found', async () => {
    savePendingCompleteSession(mockContext.workerId);
    mockGetSession.mockResolvedValue(undefined);

    const result = await confirmCompleteSessionTool.handler({}, mockContext as any);

    expect(mockUpdateSessionAgentStatus).not.toHaveBeenCalled();
    expect(mockStopWorkerInstance).not.toHaveBeenCalled();
    expect(result).toContain('Session not found');
  });

  test('returns error when session is already completed', async () => {
    savePendingCompleteSession(mockContext.workerId);
    mockGetSession.mockResolvedValue({ agentStatus: 'completed', runtimeType: 'agent-core' });

    const result = await confirmCompleteSessionTool.handler({}, mockContext as any);

    expect(mockUpdateSessionAgentStatus).not.toHaveBeenCalled();
    expect(mockStopWorkerInstance).not.toHaveBeenCalled();
    expect(result).toContain('already completed');
  });
});
