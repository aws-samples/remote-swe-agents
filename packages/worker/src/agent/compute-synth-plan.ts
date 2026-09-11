import type { MessageItem } from '@remote-swe-agents/agent-core/schema';

export interface SynthPlan {
  itemsToSynth: MessageItem[];
  rawCount: number;
  replayTrimCount: number;
}

/**
 * Compute which history items should be synthesised into v3 session files.
 * The current-turn items (determined by consumedTailCount) are excluded because
 * they will be sent as the live prompt — synthesising them would duplicate
 * content in the session store.
 *
 * Extracted so the loop and its tests call the same function — preventing
 * regression where a gate change in the loop goes undetected by tests that
 * inline their own trim logic.
 */
export const computeSynthPlan = (history: MessageItem[], consumedTailCount: number): SynthPlan => {
  const rawCount = history.length;
  const replayTrimCount = Math.max(consumedTailCount, 1);
  const itemsToSynth = rawCount > replayTrimCount ? history.slice(0, -replayTrimCount) : [];
  return { itemsToSynth, rawCount, replayTrimCount };
};
