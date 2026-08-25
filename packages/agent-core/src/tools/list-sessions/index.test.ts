import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockGetSession = vi.fn();
const mockGetChildSessions = vi.fn();
const mockGetDescendantSessions = vi.fn();
const mockGetSessions = vi.fn();
const mockResolveAgentDisplayName = vi.fn();

vi.mock('../../lib/sessions', () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
  getChildSessions: (...args: any[]) => mockGetChildSessions(...args),
  getDescendantSessions: (...args: any[]) => mockGetDescendantSessions(...args),
  getSessions: (...args: any[]) => mockGetSessions(...args),
}));

vi.mock('../../lib/agent-messaging', () => ({
  resolveAgentDisplayName: (...args: any[]) => mockResolveAgentDisplayName(...args),
}));

import { listSessionsTool } from './index';
import type { GlobalPreferences } from '../../schema';

const context = {
  workerId: 'session-caller-001',
  toolUseId: 'tool-use-1',
  globalPreferences: {} as GlobalPreferences,
};

const makeSession = (id: string, status = 'working', title?: string, parentId?: string) => ({
  PK: 'sessions',
  SK: id,
  workerId: id,
  agentStatus: status,
  title,
  parentSessionId: parentId,
  createdAt: Date.now(),
  agentName: undefined,
});

describe('listSessionsTool handler', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetChildSessions.mockReset();
    mockGetDescendantSessions.mockReset();
    mockGetSessions.mockReset();
    mockResolveAgentDisplayName.mockReset();
    mockResolveAgentDisplayName.mockImplementation((s) => s.agentName ?? s.workerId);
  });

  describe('scope=children (default)', () => {
    test('lists own children without permission check', async () => {
      const children = [
        makeSession('child-1', 'working', 'Task A', 'session-caller-001'),
        makeSession('child-2', 'completed', 'Task B', 'session-caller-001'),
      ];
      mockGetChildSessions.mockResolvedValue(children);

      const result = await listSessionsTool.handler({ scope: 'children', statusFilter: 'all' }, context);

      expect(mockGetChildSessions).toHaveBeenCalledWith('session-caller-001');
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(result).toContain('Child sessions of session-caller-001');
      expect(result).toContain('child-1');
      expect(result).toContain('child-2');
      expect(result).toContain('2 total');
    });

    test('returns empty message when no children', async () => {
      mockGetChildSessions.mockResolvedValue([]);

      const result = await listSessionsTool.handler({ scope: 'children', statusFilter: 'all' }, context);

      expect(result).toBe('No sessions found.');
    });

    test('filters active sessions', async () => {
      const children = [
        makeSession('child-1', 'working', 'Task A'),
        makeSession('child-2', 'completed', 'Task B'),
        makeSession('child-3', 'waiting', 'Task C'),
      ];
      mockGetChildSessions.mockResolvedValue(children);

      const result = await listSessionsTool.handler({ scope: 'children', statusFilter: 'active' }, context);

      expect(result).toContain('child-1');
      expect(result).not.toContain('child-2');
      expect(result).toContain('child-3');
      expect(result).toContain('2 total');
    });

    test('filters completed sessions', async () => {
      const children = [makeSession('child-1', 'working', 'Task A'), makeSession('child-2', 'completed', 'Task B')];
      mockGetChildSessions.mockResolvedValue(children);

      const result = await listSessionsTool.handler({ scope: 'children', statusFilter: 'completed' }, context);

      expect(result).not.toContain('child-1');
      expect(result).toContain('child-2');
      expect(result).toContain('1 total');
    });
  });

  describe('scope=descendants', () => {
    test('lists descendants of self without permission check', async () => {
      const descendants = [
        makeSession('child-1', 'working', 'Sub A'),
        makeSession('grandchild-1', 'completed', 'Sub Sub A'),
      ];
      mockGetDescendantSessions.mockResolvedValue(descendants);

      const result = await listSessionsTool.handler({ scope: 'descendants', statusFilter: 'all' }, context);

      expect(mockGetDescendantSessions).toHaveBeenCalledWith('session-caller-001');
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(result).toContain('Descendant sessions of session-caller-001');
      expect(result).toContain('child-1');
      expect(result).toContain('grandchild-1');
    });
  });

  describe('scope=all', () => {
    test('lists all sessions without permission check', async () => {
      const all = [
        makeSession('session-1', 'working'),
        makeSession('session-2', 'completed'),
        makeSession('session-3', 'waiting'),
      ];
      mockGetSessions.mockResolvedValue(all);

      const result = await listSessionsTool.handler({ scope: 'all', statusFilter: 'all' }, context);

      expect(mockGetSessions).toHaveBeenCalledWith(0);
      expect(result).toContain('All sessions');
      expect(result).toContain('3 total');
    });

    test('applies statusFilter to all sessions', async () => {
      const all = [makeSession('session-1', 'working'), makeSession('session-2', 'completed')];
      mockGetSessions.mockResolvedValue(all);

      const result = await listSessionsTool.handler({ scope: 'all', statusFilter: 'completed' }, context);

      expect(result).not.toContain('session-1');
      expect(result).toContain('session-2');
      expect(result).toContain('1 total');
    });
  });

  describe('permission checks (another session)', () => {
    test('allows when caller is top-level (no parent)', async () => {
      mockGetSession
        .mockResolvedValueOnce({ workerId: 'session-caller-001', parentSessionId: undefined })
        .mockResolvedValueOnce({ workerId: 'other-session', parentSessionId: 'some-parent' });
      mockGetChildSessions.mockResolvedValue([]);

      const result = await listSessionsTool.handler(
        { scope: 'children', sessionId: 'other-session', statusFilter: 'all' },
        context
      );

      expect(result).toBe('No sessions found.');
    });

    test('allows when caller is target parent', async () => {
      mockGetSession
        .mockResolvedValueOnce({ workerId: 'session-caller-001', parentSessionId: 'grandparent' })
        .mockResolvedValueOnce({ workerId: 'target-session', parentSessionId: 'session-caller-001' });
      mockGetChildSessions.mockResolvedValue([makeSession('grandchild', 'working')]);

      const result = await listSessionsTool.handler(
        { scope: 'children', sessionId: 'target-session', statusFilter: 'all' },
        context
      );

      expect(result).toContain('grandchild');
    });

    test('allows when caller is target itself', async () => {
      const selfContext = { ...context, workerId: 'target-session' };
      mockGetChildSessions.mockResolvedValue([]);

      const result = await listSessionsTool.handler(
        { scope: 'children', sessionId: 'target-session', statusFilter: 'all' },
        selfContext
      );

      expect(mockGetSession).not.toHaveBeenCalled();
      expect(result).toBe('No sessions found.');
    });

    test('denies when caller is unrelated non-top-level session', async () => {
      mockGetSession
        .mockResolvedValueOnce({ workerId: 'session-caller-001', parentSessionId: 'some-parent' })
        .mockResolvedValueOnce({ workerId: 'other-session', parentSessionId: 'different-parent' });

      const result = await listSessionsTool.handler(
        { scope: 'children', sessionId: 'other-session', statusFilter: 'all' },
        context
      );

      expect(result).toContain('Permission denied');
    });

    test('returns error when target session not found', async () => {
      mockGetSession
        .mockResolvedValueOnce({ workerId: 'session-caller-001', parentSessionId: undefined })
        .mockResolvedValueOnce(undefined);

      const result = await listSessionsTool.handler(
        { scope: 'children', sessionId: 'nonexistent', statusFilter: 'all' },
        context
      );

      expect(result).toContain('Error: Session nonexistent not found');
    });

    test('returns error when caller session not found', async () => {
      mockGetSession.mockResolvedValueOnce(undefined);

      const result = await listSessionsTool.handler(
        { scope: 'children', sessionId: 'other-session', statusFilter: 'all' },
        context
      );

      expect(result).toContain('Error: Could not retrieve current session information');
    });

    test('no permission check for scope=all even with sessionId', async () => {
      const all = [makeSession('s1', 'working')];
      mockGetSessions.mockResolvedValue(all);

      const result = await listSessionsTool.handler(
        { scope: 'all', sessionId: 'other-session', statusFilter: 'all' },
        context
      );

      expect(mockGetSession).not.toHaveBeenCalled();
      expect(result).toContain('All sessions');
    });
  });

  describe('display formatting', () => {
    test('shows title when present', async () => {
      mockGetChildSessions.mockResolvedValue([makeSession('child-1', 'working', 'My Task')]);

      const result = await listSessionsTool.handler({ scope: 'children', statusFilter: 'all' }, context);

      expect(result).toContain('— My Task');
    });

    test('omits title dash when no title', async () => {
      mockGetChildSessions.mockResolvedValue([makeSession('child-1', 'working')]);

      const result = await listSessionsTool.handler({ scope: 'children', statusFilter: 'all' }, context);

      expect(result).not.toContain('—');
    });

    test('uses agentName from resolveAgentDisplayName', async () => {
      const session = { ...makeSession('child-1', 'working'), agentName: 'My Agent' };
      mockGetChildSessions.mockResolvedValue([session]);
      mockResolveAgentDisplayName.mockResolvedValue('My Agent');

      const result = await listSessionsTool.handler({ scope: 'children', statusFilter: 'all' }, context);

      expect(result).toContain('My Agent');
    });
  });
});
