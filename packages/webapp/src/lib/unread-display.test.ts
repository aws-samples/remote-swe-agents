import { describe, expect, it } from 'vitest';
import { computeTotalUnread, getUnreadBadge } from './unread-display';

describe('getUnreadBadge', () => {
  it('hides the badge when entry is missing', () => {
    expect(getUnreadBadge(undefined)).toEqual({ visible: false, label: '' });
    expect(getUnreadBadge(null)).toEqual({ visible: false, label: '' });
  });

  it('hides the badge when unreadCount is 0 and hasPending is false', () => {
    expect(getUnreadBadge({ unreadCount: 0, hasPending: false })).toEqual({
      visible: false,
      label: '',
    });
  });

  it('shows the count when unreadCount > 0', () => {
    expect(getUnreadBadge({ unreadCount: 7, hasPending: false })).toEqual({
      visible: true,
      label: '7',
    });
  });

  it('hides badge for pending-only sessions (pending excluded from badge)', () => {
    expect(getUnreadBadge({ unreadCount: 0, hasPending: true })).toEqual({
      visible: false,
      label: '',
    });
  });

  it('shows numeric count even when pending is also set', () => {
    expect(getUnreadBadge({ unreadCount: 3, hasPending: true })).toEqual({
      visible: true,
      label: '3',
    });
  });
});

describe('computeTotalUnread (client copy)', () => {
  it('returns 0 for an empty list', () => {
    expect(computeTotalUnread([])).toBe(0);
  });

  it('sums per-session unread counts', () => {
    expect(
      computeTotalUnread([
        { unreadCount: 5, hasPending: false },
        { unreadCount: 3, hasPending: false },
      ])
    ).toBe(8);
  });

  it('pending-only sessions contribute 0 to badge total', () => {
    expect(computeTotalUnread([{ unreadCount: 0, hasPending: true }])).toBe(0);
  });

  it('ignores hasPending in aggregation', () => {
    expect(
      computeTotalUnread([
        { unreadCount: 0, hasPending: true },
        { unreadCount: 3, hasPending: false },
      ])
    ).toBe(3);
  });
});
