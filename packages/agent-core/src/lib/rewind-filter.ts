import { MessageItem } from '../schema';
import { SessionItem } from '../schema';

/**
 * Format a millisecond epoch timestamp into the zero-padded, fixed-width SK
 * representation the message table uses. Inlined here to avoid pulling in the
 * heavy `./messages` module (which imports AWS SDK / sharp) for a trivial
 * string format helper.
 */
const messageSKFromTimestamp = (timestampMs: number): string => String(timestampMs).padStart(15, '0');

export interface RewindState {
  cutoffSK: string;
  rewindedAt: number;
}

/**
 * If the cutoffSK points to a toolUse item, snap it forward to include the
 * corresponding toolResult (conventionally at SK+1). This prevents orphan
 * toolUse items that would cause Bedrock Converse 400 validation errors.
 *
 * Returns the (possibly adjusted) cutoffSK.
 */
const snapForwardToolUseCutoff = (items: MessageItem[], cutoffSK: string): string => {
  const cutoffItem = items.find((item) => item.SK === cutoffSK);
  if (!cutoffItem || cutoffItem.messageType !== 'toolUse') return cutoffSK;

  // Find the toolResult that follows this toolUse (should be SK+1 by convention)
  const toolResultItem = items.find((item) => item.SK > cutoffSK && item.messageType === 'toolResult');
  if (toolResultItem) return toolResultItem.SK;

  return cutoffSK;
};

/**
 * Post-filter defense: remove any trailing orphan toolUse items that have no
 * matching toolResult in the filtered set. This catches edge cases not handled
 * by the snap-forward (e.g. unknown orphan generation paths).
 *
 * An orphan toolUse is a toolUse item that is NOT immediately followed by a
 * toolResult item in the filtered array.
 */
const removeOrphanToolUse = (items: MessageItem[]): MessageItem[] => {
  const result: MessageItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.messageType === 'toolUse') {
      const next = items[i + 1];
      if (!next || next.messageType !== 'toolResult') {
        // Orphan toolUse — skip it
        continue;
      }
    }
    result.push(item);
  }
  return result;
};

/**
 * Non-destructive rewind filter. Given a list of message items and a session's
 * rewindState, returns only the items that should be visible:
 *   - Items with SK <= cutoffSK (before the rewind point)
 *   - Items with SK >= rewindedAtSK (new messages written after the rewind)
 *
 * Items between cutoffSK (exclusive) and rewindedAtSK (exclusive) are hidden
 * — these are the "rewound" messages.
 *
 * When rewindState is undefined/null, all items pass through unchanged.
 *
 * Safety mechanisms:
 *   1. Snap-forward: if cutoffSK points to a toolUse item, the effective
 *      cutoff is extended to include its toolResult (SK+1), preventing orphan
 *      toolUse that would cause Bedrock Converse 400 errors.
 *   2. Post-filter orphan removal: any toolUse item without an immediately
 *      following toolResult in the output is stripped as a safety net.
 *
 * This filter is designed to be applied at the history level and shared by:
 *   - The webapp UI (display filtering)
 *   - The agent loop / orchestrator (LLM context construction)
 *   - The session synthesiser
 *
 * O(n) single pass, no writes to DDB, fully reversible by clearing rewindState.
 */
export const applyRewindFilter = (items: MessageItem[], rewindState: RewindState | undefined): MessageItem[] => {
  if (!rewindState) return items;

  const { cutoffSK, rewindedAt } = rewindState;
  const rewindedAtSK = messageSKFromTimestamp(rewindedAt);

  // Snap-forward: if cutoff is on a toolUse, extend to include its toolResult
  const effectiveCutoffSK = snapForwardToolUseCutoff(items, cutoffSK);

  const filtered = items.filter((item) => {
    return item.SK <= effectiveCutoffSK || item.SK >= rewindedAtSK;
  });

  // Post-filter defense: remove any orphan toolUse items
  return removeOrphanToolUse(filtered);
};

/**
 * Convenience overload that extracts rewindState from a SessionItem.
 */
export const applyRewindFilterFromSession = (items: MessageItem[], session: SessionItem | undefined): MessageItem[] => {
  return applyRewindFilter(items, session?.rewindState);
};

/**
 * Returns the count of messages that would be hidden by the current rewindState.
 * Useful for UI indicators ("N messages hidden").
 */
export const countRewoundMessages = (items: MessageItem[], rewindState: RewindState | undefined): number => {
  if (!rewindState) return 0;

  const { cutoffSK, rewindedAt } = rewindState;
  const rewindedAtSK = messageSKFromTimestamp(rewindedAt);

  // Use the same snap-forward logic for accurate count
  const effectiveCutoffSK = snapForwardToolUseCutoff(items, cutoffSK);

  return items.filter((item) => item.SK > effectiveCutoffSK && item.SK < rewindedAtSK).length;
};
