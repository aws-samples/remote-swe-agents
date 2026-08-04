import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockGetSession = vi.fn();
const mockGetChildSessions = vi.fn();
const mockReparentSessions = vi.fn();
const mockCreateSession = vi.fn();
const mockGetWebappSessionUrl = vi.fn();

vi.mock('../../lib/sessions', () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
  getChildSessions: (...args: any[]) => mockGetChildSessions(...args),
  reparentSessions: (...args: any[]) => mockReparentSessions(...args),
}));

vi.mock('../../lib/create-session', () => ({
  createSession: (...args: any[]) => mockCreateSession(...args),
}));

vi.mock('../../lib/webapp-origin', () => ({
  getWebappSessionUrl: (...args: any[]) => mockGetWebappSessionUrl(...args),
}));

import { createNewSessionTool } from './index';
import type { GlobalPreferences } from '../../schema';

const context = {
  workerId: 'session-parent-123',
  toolUseId: 'tool-use-1',
  globalPreferences: {} as GlobalPreferences,
};

describe('createNewSessionTool handler', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockCreateSession.mockReset();
    mockGetWebappSessionUrl.mockReset();
    mockGetChildSessions.mockReset();
    mockReparentSessions.mockReset();
    mockGetChildSessions.mockResolvedValue([]);
    mockReparentSessions.mockResolvedValue(undefined);
    mockGetWebappSessionUrl.mockResolvedValue(undefined);
    mockCreateSession.mockResolvedValue('session-child-456');
  });

  test('role=child creates session with current session as parent', async () => {
    mockGetSession.mockResolvedValue({
      PK: 'sessions',
      SK: 'session-parent-123',
      workerId: 'session-parent-123',
      initiator: 'webapp#user-1',
    });

    const result = await createNewSessionTool.handler({ message: 'sub-task', role: 'child' }, context);

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    const params = mockCreateSession.mock.calls[0][0];
    expect(params.parentSessionId).toBe('session-parent-123');
    expect(params.creatorSessionId).toBeUndefined();
    expect(result).toContain('session-child-456');
    expect(result).toContain('Parent Session: session-parent-123');
  });

  test('role=independent creates session without parent', async () => {
    mockGetSession.mockResolvedValue({
      PK: 'sessions',
      SK: 'session-parent-123',
      workerId: 'session-parent-123',
      initiator: 'webapp#user-1',
    });

    const result = await createNewSessionTool.handler({ message: 'new topic', role: 'independent' }, context);

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    const params = mockCreateSession.mock.calls[0][0];
    expect(params.parentSessionId).toBeUndefined();
    expect(params.creatorSessionId).toBe('session-parent-123');
    expect(result).toContain('New session created successfully');
    expect(result).not.toContain('Parent Session');
  });

  test('role=successor performs handover: creates fresh parent and re-parents sessions', async () => {
    mockGetSession.mockResolvedValue({
      PK: 'sessions',
      SK: 'session-parent-123',
      workerId: 'session-parent-123',
      initiator: 'webapp#user-1',
    });
    mockGetChildSessions.mockResolvedValue([{ workerId: 'child-A' }, { workerId: 'child-B' }]);
    mockCreateSession.mockResolvedValue('session-newparent-789');

    const result = await createNewSessionTool.handler({ message: 'take over', role: 'successor' }, context);

    const params = mockCreateSession.mock.calls[0][0];
    expect(params.parentSessionId).toBeUndefined();
    expect(params.creatorSessionId).toBe('session-parent-123');

    expect(mockReparentSessions).toHaveBeenCalledWith('session-newparent-789', [
      'session-parent-123',
      'child-A',
      'child-B',
    ]);
    expect(result).toContain('Parent handover complete');
    expect(result).toContain('session-newparent-789');
  });

  test('role is required (schema validation rejects missing role)', () => {
    const parseResult = createNewSessionTool.schema.safeParse({ message: 'test' });
    expect(parseResult.success).toBe(false);
  });

  test('role rejects invalid values', () => {
    const parseResult = createNewSessionTool.schema.safeParse({ message: 'test', role: 'unknown' });
    expect(parseResult.success).toBe(false);
  });

  test('role=successor with 0 child sessions re-parents only self', async () => {
    mockGetSession.mockResolvedValue({
      PK: 'sessions',
      SK: 'session-parent-123',
      workerId: 'session-parent-123',
      initiator: 'webapp#user-1',
    });
    mockGetChildSessions.mockResolvedValue([]);
    mockCreateSession.mockResolvedValue('session-newparent-789');

    const result = await createNewSessionTool.handler({ message: 'take over', role: 'successor' }, context);

    expect(mockReparentSessions).toHaveBeenCalledWith('session-newparent-789', ['session-parent-123']);
    expect(result).toContain('Re-parented 1 session(s)');
    expect(result).toContain('0 existing child session(s)');
  });

  test('role=successor from a child session places successor under the same parent via createSession', async () => {
    mockGetSession.mockResolvedValue({
      PK: 'sessions',
      SK: 'session-parent-123',
      workerId: 'session-parent-123',
      initiator: 'webapp#user-1',
      parentSessionId: 'session-grandparent-000',
    });
    mockGetChildSessions.mockResolvedValue([{ workerId: 'child-A' }]);
    mockCreateSession.mockResolvedValue('session-successor-999');

    const result = await createNewSessionTool.handler({ message: 'take over', role: 'successor' }, context);

    expect(mockReparentSessions).toHaveBeenCalledTimes(1);
    expect(mockReparentSessions).toHaveBeenCalledWith('session-successor-999', ['session-parent-123', 'child-A']);
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ parentSessionId: 'session-grandparent-000' })
    );
    expect(result).toContain('Parent handover complete');
    expect(result).toContain('session-successor-999');
  });

  test('role=successor from a top-level session does not pass parentSessionId to createSession', async () => {
    mockGetSession.mockResolvedValue({
      PK: 'sessions',
      SK: 'session-parent-123',
      workerId: 'session-parent-123',
      initiator: 'webapp#user-1',
    });
    mockGetChildSessions.mockResolvedValue([]);
    mockCreateSession.mockResolvedValue('session-newparent-789');

    await createNewSessionTool.handler({ message: 'take over', role: 'successor' }, context);

    expect(mockReparentSessions).toHaveBeenCalledTimes(1);
    expect(mockReparentSessions).toHaveBeenCalledWith('session-newparent-789', ['session-parent-123']);
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ parentSessionId: undefined }));
  });
});
