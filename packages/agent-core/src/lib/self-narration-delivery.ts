/**
 * DynamoDB-backed glue between the pure self-narration / rehash / wake-up
 * monologue decision logic (`self-narration-filter.ts`) and the single
 * end-of-turn delivery choke-point (`orchestrator.finalizeTurn`).
 *
 * Why a separate file: `self-narration-filter.ts` is deliberately IO-free so
 * its decisions are unit-testable without DynamoDB. This module performs the
 * windowed read and assembles the structural facts the pure functions need.
 *
 * ## What "prior messages" means at finalize time
 *
 * By the time `finalizeTurn` runs, everything THIS turn already delivered/sent
 * is persisted in the worker's own `message-{workerId}` partition:
 *   - `userDeliveryLog`   — every end-of-turn / report-progress delivery
 *   - `communicationLog`  — every `sendMessageToAgent` / `acknowledgeAgent`
 *   - `toolUse`           — the send-tool calls (carry `input.message`)
 * plus the same three types from recent PRIOR turns inside the dedup window.
 * So a single windowed read covers BOTH A-1 (cross-turn rehash) and A-2
 * (same-turn self-narration) without depending on `ctx.history` (which is only
 * a snapshot from turn start and never sees this turn's own writes).
 *
 * ## Conservatism / fail-open
 *
 * Every entry point swallows its own read errors and returns `false`
 * (DELIVER), mirroring the rest of the dedup family: a bookkeeping failure must
 * never drop a genuine message.
 */

import { getRecentMessages } from './messages';
import { DEFAULT_DEDUP_WINDOW_MS, RecentMessageForDedup } from './message-dedup';
import { USER_DELIVERY_LOG_MESSAGE_TYPE, isMessageDeliveryToolName } from './user-delivery-dedup';
import { isRehashOrSelfNarration, shouldSuppressWakeupMonologue, hadNewWorkTool } from './self-narration-filter';
import { MessageItem } from '../schema';

/** Parse a persisted message item's JSON content blocks into plain text. */
const itemText = (it: MessageItem): string => {
  try {
    const parsed = JSON.parse(it.content) as Array<{ text?: string }>;
    return parsed
      .map((c) => c.text ?? '')
      .filter((t) => t)
      .join('\n');
  } catch {
    return it.content;
  }
};

/**
 * Collect every recent message this session DELIVERED to the user or SENT to a
 * peer within the window — the candidate set a rehash / self-narration would
 * echo. Sources: `userDeliveryLog` rows, `communicationLog` rows (this
 * session's own outgoing agent messages), and message-delivery `toolUse` rows.
 */
const collectPriorDeliveries = (items: MessageItem[]): RecentMessageForDedup[] => {
  const out: RecentMessageForDedup[] = [];
  for (const it of items) {
    const ts = Number(it.SK);
    if (it.messageType === USER_DELIVERY_LOG_MESSAGE_TYPE || it.messageType === 'communicationLog') {
      const text = itemText(it);
      if (text) out.push({ message: text, timestampMs: ts });
      continue;
    }
    if (it.messageType === 'toolUse') {
      let blocks: unknown;
      try {
        blocks = JSON.parse(it.content);
      } catch {
        continue;
      }
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        const toolUse = (block as { toolUse?: { name?: string; input?: { message?: unknown } } })?.toolUse;
        if (!toolUse || !isMessageDeliveryToolName(toolUse.name)) continue;
        const msg = toolUse.input?.message;
        if (typeof msg === 'string' && msg.length > 0) out.push({ message: msg, timestampMs: ts });
      }
    }
  }
  return out;
};

/**
 * Names of every tool whose `toolUse` was persisted strictly AFTER the
 * turn-start boundary SK — i.e. the tools that ran THIS turn. Used to decide
 * `hadNewWorkTool` for the A-3 structural gate.
 */
const collectThisTurnToolNames = (items: MessageItem[], turnStartSK: string | undefined): string[] => {
  const names: string[] = [];
  const boundary = turnStartSK == null ? -Infinity : Number(turnStartSK);
  for (const it of items) {
    if (it.messageType !== 'toolUse') continue;
    if (Number(it.SK) <= boundary) continue;
    let blocks: unknown;
    try {
      blocks = JSON.parse(it.content);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const name = (block as { toolUse?: { name?: string } })?.toolUse?.name;
      if (typeof name === 'string') names.push(name);
    }
  }
  return names;
};

/**
 * A-1 + A-2: decide whether `deliveredText` should be suppressed as a rehash of
 * — or self-narration about — something this session already delivered/sent
 * within the window. Reads the worker's own recent deliveries and applies the
 * pure near-duplicate + containment heuristic. Fail-open.
 */
export const shouldSuppressRehashOrSelfNarration = async (
  workerId: string,
  deliveredText: string,
  nowMs: number = Date.now(),
  windowMs: number = DEFAULT_DEDUP_WINDOW_MS
): Promise<boolean> => {
  try {
    const items = await getRecentMessages(workerId, nowMs - windowMs);
    const prior = collectPriorDeliveries(items).filter(
      (p) => p.timestampMs <= nowMs && nowMs - p.timestampMs <= windowMs
    );
    return isRehashOrSelfNarration(deliveredText, prior);
  } catch (e) {
    console.error('[self-narration] rehash/self-narration check failed; delivering anyway:', e);
    return false;
  }
};

/**
 * A-3: decide whether `deliveredText` is a no-information wake-up monologue
 * that should be suppressed. Applies the STRUCTURAL gate first (non-user
 * trigger + zero new work tool this turn) and only then the text-pattern
 * condition. `turnStartSK` is the SK of the last history item at turn start
 * (the triggering message); tool rows after it are this turn's tools.
 * Fail-open.
 */
export const shouldSuppressWakeupMonologueDelivery = async (
  workerId: string,
  deliveredText: string,
  opts: { triggerMessageType: string | undefined; turnStartSK: string | undefined },
  nowMs: number = Date.now(),
  windowMs: number = DEFAULT_DEDUP_WINDOW_MS
): Promise<boolean> => {
  try {
    const items = await getRecentMessages(workerId, nowMs - windowMs);
    const toolNames = collectThisTurnToolNames(items, opts.turnStartSK);
    return shouldSuppressWakeupMonologue({
      triggerMessageType: opts.triggerMessageType,
      hadNewWorkTool: hadNewWorkTool(toolNames),
      text: deliveredText,
    });
  } catch (e) {
    console.error('[self-narration] wake-up monologue check failed; delivering anyway:', e);
    return false;
  }
};
