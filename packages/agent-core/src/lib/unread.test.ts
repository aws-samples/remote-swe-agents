import { describe, expect, it } from 'vitest';
import { computeTotalUnread } from './unread';

/**
 * `computeTotalUnread` = sum of unreadCount only. `hasPending` is excluded
 * from badge calculation — badge represents "messages delivered to user but
 * not yet read", not "agent is waiting for input".
 */
describe('computeTotalUnread', () => {
  it('returns 0 when there are no unread items', () => {
    expect(computeTotalUnread([])).toBe(0);
  });

  it('sums unread messages per session', () => {
    expect(
      computeTotalUnread([
        { unreadCount: 5, hasPending: false },
        { unreadCount: 3, hasPending: false },
      ])
    ).toBe(8);
  });

  it('pending-only sessions contribute 0', () => {
    expect(computeTotalUnread([{ unreadCount: 0, hasPending: true }])).toBe(0);
  });

  it('ignores hasPending flag in calculation', () => {
    expect(computeTotalUnread([{ unreadCount: 3, hasPending: true }])).toBe(3);
  });

  it('single session with high unread count', () => {
    expect(computeTotalUnread([{ unreadCount: 10, hasPending: false }])).toBe(10);
  });

  it('multiple sessions sum correctly', () => {
    expect(
      computeTotalUnread([
        { unreadCount: 5, hasPending: false },
        { unreadCount: 5, hasPending: false },
      ])
    ).toBe(10);
  });

  it('mixed pending and non-pending: only unreadCount matters', () => {
    expect(
      computeTotalUnread([
        { unreadCount: 0, hasPending: true },
        { unreadCount: 3, hasPending: false },
      ])
    ).toBe(3);
  });
});
