import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import { getRecentMessages } from './messages';
import {
  shouldSuppressDuplicateMessage,
  DEFAULT_DEDUP_WINDOW_MS,
  MIN_DEDUP_LENGTH,
  normalizeForDedup,
  RecentMessageForDedup,
} from './message-dedup';
import { MessageItem } from '../schema';

/**
 * Internal messageType used to mirror every message that was actually
 * delivered to the USER (Slack / web push / last-message preview), so the
 * user-facing delivery path can dedup against its own recent history — exactly
 * mirroring how `communicationLog` lets the agent-to-agent path
 * (`agent-messaging.ts`) suppress resurrection re-emits.
 *
 * ## Why this exists
 *
 * When a turn fails at the inference stage (kiro-cli `-32603` "Internal error"
 * / prompt timeout) AFTER it has already delivered a user-facing message, the
 * orchestrator schedules an auto-retrigger (`systemRetrigger`) and re-runs the
 * turn from the top. kiro-cli resumes its own session memory via
 * `session/load`, so the model re-decides to call `sendMessageToUser` and/or
 * re-emits the same end-of-turn text. The user-facing delivery functions had
 * NO duplicate suppression (unlike the agent-messaging path), so the user
 * received the same message twice.
 *
 * This log + the {@link shouldSuppressUserDelivery} predicate close that gap at
 * the single user-facing choke-point.
 *
 * ## Filtering
 *
 * `userDeliveryLog` items are UI/internal mirrors and MUST never enter an LLM
 * context. They are excluded from `getConversationHistory` (and
 * `middleOutFiltering`) by default, alongside `communicationLog`.
 */
export const USER_DELIVERY_LOG_MESSAGE_TYPE = 'userDeliveryLog';

/**
 * TTL (seconds) applied to `userDeliveryLog` rows. These are ephemeral dedup
 * bookkeeping records — far shorter-lived than conversation history — so they
 * carry a DynamoDB native TTL (the History table enables `timeToLiveAttribute:
 * 'TTL'`, see `cdk/lib/constructs/storage.ts`) to keep long-lived sessions from
 * accumulating them. 1 hour comfortably covers the 5-minute dedup window with
 * generous slack for clock skew and the TTL sweeper's asynchronous deletion.
 */
const USER_DELIVERY_LOG_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * Decide whether a user-facing message should be suppressed because an
 * (almost) identical message was already delivered to this user within the
 * dedup window. Reads the worker's own `userDeliveryLog` mirror rows scoped to
 * the window at the DynamoDB layer (`getRecentMessages` issues a `SK >= cutoff`
 * KeyCondition) and applies the shared conservative near-duplicate heuristic
 * (`shouldSuppressDuplicateMessage`): short messages are NEVER deduped and only
 * an exact / high-similarity match inside the window fires.
 *
 * Conservative by design — the cost of a false positive (dropping a genuinely
 * new message) is higher than a false negative, so this only catches the
 * narrow retrigger re-emit case.
 */
export const shouldSuppressUserDelivery = async (
  workerId: string,
  message: string,
  nowMs: number = Date.now(),
  windowMs: number = DEFAULT_DEDUP_WINDOW_MS
): Promise<boolean> => {
  // Short-circuit: messages below MIN_DEDUP_LENGTH normalised chars are NEVER
  // deduped (see message-dedup.ts), so skip the DynamoDB lookup entirely for
  // them. This avoids a wasted read on every short status / "ok" delivery —
  // the dominant case — and is behaviourally identical to letting the
  // heuristic reject them downstream.
  if (normalizeForDedup(message).length < MIN_DEDUP_LENGTH) return false;
  try {
    const history = await getRecentMessages(workerId, nowMs - windowMs);
    const recent: RecentMessageForDedup[] = history
      .filter((it) => it.messageType === USER_DELIVERY_LOG_MESSAGE_TYPE)
      .map((it) => {
        let text = '';
        try {
          const parsed = JSON.parse(it.content) as Array<{ text?: string }>;
          text = parsed
            .map((c) => c.text ?? '')
            .filter((t) => t)
            .join('\n');
        } catch {
          text = it.content;
        }
        return { message: text, timestampMs: Number(it.SK) };
      });
    return shouldSuppressDuplicateMessage(message, recent, nowMs, windowMs);
  } catch (e) {
    // Never let a dedup-lookup failure block a genuine delivery.
    console.error('[user-delivery-dedup] Failed to read recent deliveries:', e);
    return false;
  }
};

/**
 * Persist a `userDeliveryLog` mirror row recording that `message` was delivered
 * to the user. Best-effort: a persist failure must never break the actual
 * delivery (the message was already sent), so errors are swallowed after
 * logging.
 */
export const recordUserDelivery = async (
  workerId: string,
  message: string,
  nowMs: number = Date.now()
): Promise<void> => {
  try {
    const item: MessageItem = {
      PK: `message-${workerId}`,
      SK: String(nowMs).padStart(15, '0'),
      content: JSON.stringify([{ text: message }]),
      role: 'assistant',
      tokenCount: 0,
      messageType: USER_DELIVERY_LOG_MESSAGE_TYPE,
      TTL: Math.floor(nowMs / 1000) + USER_DELIVERY_LOG_TTL_SECONDS,
    };
    await ddb.send(new PutCommand({ TableName, Item: item }));
  } catch (e) {
    console.error('[user-delivery-dedup] Failed to record user delivery:', e);
  }
};

/**
 * Tool names whose `toolUse` carries a user-facing message that the webapp
 * renders as an assistant chat bubble (and which is persisted as a `toolUse`
 * history item). Kept in sync with the webapp's own message-rendering set
 * (`isMsg` in `sessions/[workerId]/page.tsx` + `SessionPageClient.tsx`).
 * `sendMessageToUserIfNecessary` is a legacy name still honoured by the
 * renderer, so it is included defensively even though no live tool registers
 * it today.
 */
export const MESSAGE_DELIVERY_TOOL_NAMES = [
  'Send Message To User',
  'Send Image To User',
  'Send File To User',
  // Legacy camelCase names still present in persisted conversation history
  'sendMessageToUser',
  'sendMessageToUserIfNecessary',
  'sendImageToUser',
  'sendFileToUser',
] as const;

/** True when `name` is one of the user-facing message-delivery tools. */
export const isMessageDeliveryToolName = (name: string | undefined): boolean =>
  MESSAGE_DELIVERY_TOOL_NAMES.includes((name ?? '') as (typeof MESSAGE_DELIVERY_TOOL_NAMES)[number]);

/**
 * Extract the user-facing `message` text from persisted `toolUse` history
 * items that invoked a message-delivery tool. Each yielded entry is timestamped
 * by the item's SK so the caller can apply the windowed dedup. Malformed /
 * non-matching items are silently skipped.
 */
const extractDeliveryToolMessages = (items: MessageItem[]): RecentMessageForDedup[] => {
  const out: RecentMessageForDedup[] = [];
  for (const it of items) {
    if (it.messageType !== 'toolUse') continue;
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
      if (typeof msg === 'string' && msg.length > 0) {
        out.push({ message: msg, timestampMs: Number(it.SK) });
      }
    }
  }
  return out;
};

/**
 * Decide whether an about-to-be-persisted `toolUse` for a message-delivery
 * tool should be suppressed because an (almost) identical message-delivery
 * `toolUse` was ALREADY persisted within the dedup window.
 *
 * ## Why this is separate from {@link shouldSuppressUserDelivery}
 *
 * The Slack/push delivery path (the MCP `sendMessageToUser` handler) and the
 * webapp `toolUse` persist+emit path (the worker's kiro-cli ACP `onEvent`) run
 * in DIFFERENT processes for kiro-cli sessions. If both deduped against — and
 * wrote to — the same `userDeliveryLog`, the handler's same-turn record could
 * race ahead of the `onEvent` check and falsely suppress the FIRST persist
 * (the worst regression: nothing rendered in the webapp).
 *
 * So this predicate instead dedups against the worker's OWN authoritative
 * record — the previously persisted `toolUse` items. Within a turn there is
 * exactly one persist per `tool_call`, so the first delivery can never be
 * suppressed; on an auto-retrigger turn the previous turn's `toolUse` is
 * already in DynamoDB and the re-emit is caught. This directly targets the
 * observed incident (two `toolUse:sendMessageToUser` rows in history).
 *
 * Reuses the same conservative heuristic as the rest of the dedup family
 * (short messages never deduped, 5-min window, bigram Jaccard ≥ 0.3). Caller
 * MUST gate on {@link isMessageDeliveryToolName} first — this only inspects
 * prior message-delivery `toolUse` items, never other tools.
 */
export const shouldSuppressToolUseRedelivery = async (
  workerId: string,
  message: string,
  nowMs: number = Date.now(),
  windowMs: number = DEFAULT_DEDUP_WINDOW_MS
): Promise<boolean> => {
  if (normalizeForDedup(message).length < MIN_DEDUP_LENGTH) return false;
  try {
    const history = await getRecentMessages(workerId, nowMs - windowMs);
    const recent = extractDeliveryToolMessages(history);
    return shouldSuppressDuplicateMessage(message, recent, nowMs, windowMs);
  } catch (e) {
    // Never let a dedup-lookup failure block a genuine persist/emit.
    console.error('[user-delivery-dedup] Failed to read recent toolUse deliveries:', e);
    return false;
  }
};
