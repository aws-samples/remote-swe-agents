/**
 * @file Dedup of rebroadcast 'message' events against existing optimistic /
 * recently-confirmed user bubbles.
 *
 * The webapp persists user messages optimistically: the submitter sees a
 * `pending: true` bubble immediately, then the server action's rebroadcast
 * fires shortly after. Without dedup the submitter would see two bubbles
 * for the same submission.
 *
 * Identification is by **client-side UUID**: `MessageForm` stamps a
 * `crypto.randomUUID()` on every optimistic submit, ships it with the
 * server action, and the action forwards it verbatim onto the rebroadcast
 * event (`webappEventSchema.message.clientId`). When the echo lands on
 * the originating tab, `mergeDuplicateUserRebroadcast` finds the matching
 * bubble by that id.
 *
 * Why a UUID instead of body-text + time-window?
 *   - The previous heuristic compared `formatMessage(content)` strings
 *     within a 30 s window plus a separate 5 min cap for stale `pending`
 *     stubs. It worked, but had two known soft spots:
 *       1. Two legitimately-identical messages typed back-to-back inside
 *          the window were collapsed into one.
 *       2. Any future change to `formatMessage` could silently shift the
 *          dedup boundary.
 *   - A per-submission UUID is uniquely identifying by construction. A
 *     match is "this rebroadcast IS my submit"; no time window or content
 *     comparison required.
 *
 * Backwards compatibility:
 *   - The `clientId` field is optional on both the form action input and
 *     the rebroadcast event schema. Older clients (or non-webapp callers
 *     such as Slack / REST API) emit events without a clientId; the dedup
 *     treats those as non-duplicates, so they always render.
 *   - Memory-only: clientId is NEVER persisted to DynamoDB, so a page
 *     reload sees a single bubble (the historical record), not the
 *     optimistic one.
 */
import type { MessageView } from './MessageList';

export type RebroadcastAttachments = {
  imageKeys?: string[];
  fileKeys?: string[];
};

/**
 * Dedup a user rebroadcast against an existing optimistic bubble, MERGING
 * the event's attachment keys onto the bubble instead of discarding them.
 *
 * Why merging matters (bug fix): the optimistic bubble used to carry no
 * `imageKeys` / `fileKeys`, and the rebroadcast — the only realtime carrier
 * of those keys back to the submitter's own tab — was dropped wholesale by
 * the clientId dedup. Result: the submitter never saw their own attachments
 * until a full server re-render (reload / reconnect refresh). Merging closes
 * that hole regardless of whether the optimistic bubble carries attachments:
 * if the bubble already has the keys (instant-preview path) the array is
 * returned untouched; if it lacks them, the event's keys are attached.
 *
 * Returns:
 *   - `null` when the event is NOT a duplicate (no bubble matches the
 *     clientId, or the event carries no clientId) — the caller should append
 *     a new bubble as usual.
 *   - the previous array (same reference) when the duplicate bubble already
 *     has everything the event carries — the caller can return it as-is and
 *     React skips the re-render.
 *   - a new array with the matched bubble's attachments filled in when the
 *     event carries keys the bubble lacks. Existing bubble fields (id,
 *     pending, clientId, localImageUrls) are preserved so the pending →
 *     confirmed transition and the blob-preview swap are unaffected.
 */
export function mergeDuplicateUserRebroadcast(
  prev: MessageView[],
  eventClientId: string | undefined,
  attachments: RebroadcastAttachments
): MessageView[] | null {
  if (!eventClientId) return null;
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i];
    if (m.role !== 'user' || m.type !== 'message') continue;
    if (m.clientId !== eventClientId) continue;
    const needsImageKeys = !!attachments.imageKeys?.length && !m.imageKeys?.length;
    const needsFileKeys = !!attachments.fileKeys?.length && !m.fileKeys?.length;
    if (!needsImageKeys && !needsFileKeys) return prev;
    const next = [...prev];
    next[i] = {
      ...m,
      ...(needsImageKeys ? { imageKeys: attachments.imageKeys } : {}),
      ...(needsFileKeys ? { fileKeys: attachments.fileKeys } : {}),
    };
    return next;
  }
  return null;
}
