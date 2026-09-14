/**
 * @file Consistency check between a `lastMessageUpdate` realtime event and the
 * currently-rendered chat bubbles.
 *
 * AppSync Events has no replay: a bubble-drawing event (`toolUse` (Send
 * Message To User) / `message`) published while the socket was momentarily
 * down is lost forever, but the paired `lastMessageUpdate` (a separate emit)
 * may still arrive. When the update's preview text has no matching bubble on
 * screen, that is evidence the drawing event was dropped, so the session page
 * self-recovers with `router.refresh()` (which works even on a hidden tab,
 * unlike the focus/visibility-gated recovery paths).
 *
 * Kept as a pure, client-safe module (no runtime imports beyond the
 * client-safe `formatMessage`) so it can be unit-tested in isolation and so
 * it never drags server-only code into the browser bundle.
 */
import { formatMessage } from '@/lib/message-formatter';
import type { MessageView } from './MessageList';

/**
 * Number of leading (whitespace-compacted) characters compared between the
 * update preview and a rendered bubble. Both strings pass through
 * `formatMessage`, so a bubble that corresponds to the preview shares an
 * identical prefix; the 500-char server-side truncation of the preview and
 * URL re-spacing only diverge further along, so a short prefix match is a
 * robust "same message" signal without risking cross-message collisions.
 */
const PREFIX_MATCH_LEN = 40;

/** Collapse all whitespace runs to single spaces and trim. */
function compact(text: string): string {
  return formatMessage(text).replace(/\s+/g, ' ').trim();
}

/**
 * Returns `true` when `preview` (the `lastMessageUpdate.lastMessage` payload)
 * appears to already be rendered among `messages`.
 *
 * Matching rules (deliberately conservative to avoid a false "present" that
 * would suppress a real recovery):
 *   - The comparison length is `min(PREFIX_MATCH_LEN, compactedPreview.length)`
 *     -- driven by the PREVIEW only, never shortened by the bubble. A bubble
 *     must contain AT LEAST that many matching leading characters, so a short
 *     bubble (e.g. a two-word status line) can no longer wildcard-match a
 *     longer preview just because it shares the opening characters.
 *   - `toolUse` bubbles are skipped entirely: their `content` is the tool
 *     name (short, highly collision-prone) and a preview is never derived
 *     from a generic tool-use bubble (previews come from `sendMessageToUser`
 *     -> `message` bubbles and from user submissions).
 *
 * Empty previews are treated as "present" (nothing to recover).
 */
export function isPreviewRendered(messages: MessageView[], preview: string): boolean {
  const p = compact(preview);
  if (!p) return true;
  const n = Math.min(PREFIX_MATCH_LEN, p.length);
  const pPrefix = p.slice(0, n);
  for (const m of messages) {
    if (m.type === 'toolUse') continue;
    if (!m.content) continue;
    const c = compact(m.content);
    if (c.length < n) continue;
    if (c.slice(0, n) === pPrefix) {
      return true;
    }
  }
  return false;
}
