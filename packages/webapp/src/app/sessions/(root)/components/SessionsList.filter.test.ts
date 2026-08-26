import { describe, expect, it } from 'vitest';
import type { SessionItem } from '@remote-swe-agents/agent-core/schema';

/**
 * Extracted filter logic from SessionsList's sortedSessions useMemo.
 * Visibility is controlled solely by agentStatus (no isHidden concept).
 */
function filterSessions(sessions: SessionItem[], hideCompleted: boolean, titleFilter = ''): SessionItem[] {
  let filtered = sessions.filter((s) => !s.parentSessionId);
  if (hideCompleted) {
    filtered = filtered.filter((s) => s.agentStatus !== 'completed');
  }
  if (titleFilter.trim()) {
    const query = titleFilter.trim().toLowerCase();
    filtered = filtered.filter((s) => {
      const title = (s.title || s.SK || '').toLowerCase();
      return title.includes(query);
    });
  }
  return filtered;
}

function makeSession(overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    PK: 'sessions',
    SK: `session-${Math.random()}`,
    workerId: `worker-${Math.random()}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    LSI1: '1',
    initialMessage: 'test',
    instanceStatus: 'stopped',
    sessionCost: 0,
    agentStatus: 'pending',
    ...overrides,
  };
}

describe('SessionsList filter logic (status-based)', () => {
  const activeSession = makeSession({ agentStatus: 'working' });
  const completedSession = makeSession({ agentStatus: 'completed' });
  const childSession = makeSession({ parentSessionId: 'parent-1' });

  const allSessions = [activeSession, completedSession, childSession];

  it('hideCompleted=false shows completed sessions', () => {
    const result = filterSessions(allSessions, false);
    expect(result).toContainEqual(activeSession);
    expect(result).toContainEqual(completedSession);
  });

  it('hideCompleted=true hides completed sessions', () => {
    const result = filterSessions(allSessions, true);
    expect(result).toContainEqual(activeSession);
    expect(result).not.toContainEqual(completedSession);
  });

  it('child sessions are always excluded from root list', () => {
    const result = filterSessions(allSessions, false);
    expect(result).not.toContainEqual(childSession);
  });
});

describe('SessionsList title filter', () => {
  const session1 = makeSession({ title: 'Fix login bug' });
  const session2 = makeSession({ title: 'Add search feature' });
  const session3 = makeSession({ title: 'Refactor API' });
  const sessionNoTitle = makeSession({ title: undefined });

  const allSessions = [session1, session2, session3, sessionNoTitle];

  it('empty filter returns all root sessions', () => {
    const result = filterSessions(allSessions, false, '');
    expect(result).toHaveLength(4);
  });

  it('whitespace-only filter returns all root sessions', () => {
    const result = filterSessions(allSessions, false, '   ');
    expect(result).toHaveLength(4);
  });

  it('filters by title case-insensitively', () => {
    const result = filterSessions(allSessions, false, 'fix');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(session1);
  });

  it('filters by partial match', () => {
    const result = filterSessions(allSessions, false, 'search');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(session2);
  });

  it('returns empty when no match', () => {
    const result = filterSessions(allSessions, false, 'nonexistent');
    expect(result).toHaveLength(0);
  });

  it('title filter combines with hideCompleted', () => {
    const completedWithTitle = makeSession({ title: 'Fix login bug completed', agentStatus: 'completed' });
    const sessions = [session1, completedWithTitle];
    const result = filterSessions(sessions, true, 'fix');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(session1);
  });

  it('sessions without title fall back to SK for filtering', () => {
    const sessionWithSK = makeSession({ title: undefined, SK: 'session-api-key-test' });
    const result = filterSessions([sessionWithSK], false, 'api-key');
    expect(result).toHaveLength(1);
  });
});
