import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockGetSession = vi.fn();
const mockUpdateSessionAgentStatus = vi.fn();
const mockStopWorkerInstance = vi.fn();
const mockSendWebappEvent = vi.fn();
const mockSavePendingCompleteSession = vi.fn();

vi.mock('../../lib', () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
  updateSessionAgentStatus: (...args: any[]) => mockUpdateSessionAgentStatus(...args),
  stopWorkerInstance: (...args: any[]) => mockStopWorkerInstance(...args),
}));

vi.mock('../../lib/events', () => ({
  sendWebappEvent: (...args: any[]) => mockSendWebappEvent(...args),
}));

vi.mock('../confirm-complete-session', () => ({
  savePendingCompleteSession: (...args: any[]) => mockSavePendingCompleteSession(...args),
}));

import { completeSessionTool } from './index';

const mockContext = {
  workerId: 'test-worker-123',
  toolUseId: 'test-tool-use',
  globalPreferences: { PK: 'global-config', SK: 'general' },
};

describe('completeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('child session (has parentSessionId)', () => {
    test('completes itself immediately without confirmation', async () => {
      mockGetSession.mockResolvedValue({
        agentStatus: 'working',
        runtimeType: 'agent-core',
        parentSessionId: 'parent-123',
      });

      const result = await completeSessionTool.handler({}, mockContext as any);

      expect(mockSavePendingCompleteSession).not.toHaveBeenCalled();
      expect(mockUpdateSessionAgentStatus).toHaveBeenCalledWith('test-worker-123', 'completed');
      expect(mockSendWebappEvent).toHaveBeenCalledWith('test-worker-123', {
        type: 'agentStatusUpdate',
        status: 'completed',
      });
      expect(mockStopWorkerInstance).toHaveBeenCalledWith('test-worker-123', 'agent-core');
      expect(result).toContain('completed');
    });

    test('completes itself when explicitly specifying own sessionId', async () => {
      mockGetSession.mockResolvedValue({
        agentStatus: 'working',
        runtimeType: 'agent-core',
        parentSessionId: 'parent-123',
      });

      const result = await completeSessionTool.handler({ sessionId: 'test-worker-123' }, mockContext as any);

      expect(mockSavePendingCompleteSession).not.toHaveBeenCalled();
      expect(mockUpdateSessionAgentStatus).toHaveBeenCalledWith('test-worker-123', 'completed');
      expect(mockStopWorkerInstance).toHaveBeenCalledWith('test-worker-123', 'agent-core');
      expect(result).toContain('completed');
    });

    test('rejects completing another session', async () => {
      mockGetSession.mockResolvedValue({
        agentStatus: 'working',
        runtimeType: 'agent-core',
        parentSessionId: 'parent-123',
      });

      const result = await completeSessionTool.handler({ sessionId: 'other-session-456' }, mockContext as any);

      expect(mockUpdateSessionAgentStatus).not.toHaveBeenCalled();
      expect(mockStopWorkerInstance).not.toHaveBeenCalled();
      expect(result).toContain('Permission denied');
    });
  });

  describe('top-level session (no parentSessionId)', () => {
    test('self-completion triggers confirmation guard', async () => {
      mockGetSession.mockResolvedValue({ agentStatus: 'working', runtimeType: 'agent-core' });

      const result = await completeSessionTool.handler({}, mockContext as any);

      expect(mockSavePendingCompleteSession).toHaveBeenCalledWith('test-worker-123');
      expect(mockUpdateSessionAgentStatus).not.toHaveBeenCalled();
      expect(mockStopWorkerInstance).not.toHaveBeenCalled();
      expect(result).toContain('CONFIRMATION REQUIRED');
      expect(result).toContain('Confirm Complete Session');
    });

    test('self-completion with explicit sessionId also triggers confirmation guard', async () => {
      mockGetSession.mockResolvedValue({ agentStatus: 'working', runtimeType: 'agent-core' });

      const result = await completeSessionTool.handler({ sessionId: 'test-worker-123' }, mockContext as any);

      expect(mockSavePendingCompleteSession).toHaveBeenCalledWith('test-worker-123');
      expect(mockUpdateSessionAgentStatus).not.toHaveBeenCalled();
      expect(mockStopWorkerInstance).not.toHaveBeenCalled();
      expect(result).toContain('CONFIRMATION REQUIRED');
      expect(result).toContain('Confirm Complete Session');
    });

    test('completing another session succeeds immediately', async () => {
      mockGetSession
        .mockResolvedValueOnce({ agentStatus: 'working', runtimeType: 'agent-core' }) // caller
        .mockResolvedValueOnce({ agentStatus: 'working', runtimeType: 'ec2' }); // target

      const result = await completeSessionTool.handler({ sessionId: 'other-session-456' }, mockContext as any);

      expect(mockGetSession).toHaveBeenCalledWith('test-worker-123');
      expect(mockGetSession).toHaveBeenCalledWith('other-session-456');
      expect(mockSavePendingCompleteSession).not.toHaveBeenCalled();
      expect(mockUpdateSessionAgentStatus).toHaveBeenCalledWith('other-session-456', 'completed');
      expect(mockSendWebappEvent).toHaveBeenCalledWith('other-session-456', {
        type: 'agentStatusUpdate',
        status: 'completed',
      });
      expect(mockStopWorkerInstance).toHaveBeenCalledWith('other-session-456', 'ec2');
      expect(result).toContain('completed');
    });

    test('completing another session that does not exist returns not found', async () => {
      mockGetSession
        .mockResolvedValueOnce({ agentStatus: 'working', runtimeType: 'agent-core' }) // caller
        .mockResolvedValueOnce(undefined); // target

      const result = await completeSessionTool.handler({ sessionId: 'nonexistent' }, mockContext as any);

      expect(mockUpdateSessionAgentStatus).not.toHaveBeenCalled();
      expect(result).toContain('not found');
    });
  });

  describe('common cases', () => {
    test('is idempotent - no-op if already completed', async () => {
      mockGetSession.mockResolvedValue({ agentStatus: 'completed', runtimeType: 'ec2' });

      const result = await completeSessionTool.handler({}, mockContext as any);

      expect(mockUpdateSessionAgentStatus).not.toHaveBeenCalled();
      expect(mockStopWorkerInstance).not.toHaveBeenCalled();
      expect(result).toContain('already completed');
    });

    test('returns not found when caller session does not exist', async () => {
      mockGetSession.mockResolvedValue(undefined);

      const result = await completeSessionTool.handler({}, mockContext as any);

      expect(mockUpdateSessionAgentStatus).not.toHaveBeenCalled();
      expect(mockStopWorkerInstance).not.toHaveBeenCalled();
      expect(result).toContain('not found');
    });
  });
});
