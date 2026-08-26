/**
 * Per-session badge display rules. Badge shows only when there are actual
 * unread messages (`unreadCount > 0`). Pending state is intentionally excluded
 * from badge display — the badge represents "messages delivered to user but
 * not yet read", not "agent is waiting".
 */
export interface UnreadEntry {
  unreadCount: number;
  hasPending: boolean;
}

export interface BadgeDisplay {
  visible: boolean;
  label: string;
}

const HIDDEN: BadgeDisplay = { visible: false, label: '' };

export function getUnreadBadge(entry: UnreadEntry | undefined | null): BadgeDisplay {
  if (!entry) return HIDDEN;
  if (entry.unreadCount > 0) return { visible: true, label: String(entry.unreadCount) };
  return HIDDEN;
}

/**
 * Aggregate badge total. Mirrors `computeTotalUnread` in
 * `@remote-swe-agents/agent-core/lib`. Badge = sum of unreadCount only.
 * `hasPending` is excluded — badge represents delivered messages, not agent state.
 */
export function computeTotalUnread(items: ReadonlyArray<UnreadEntry>): number {
  return items.reduce((sum, item) => sum + item.unreadCount, 0);
}
