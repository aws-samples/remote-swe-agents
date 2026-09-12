/**
 * Pure data / types describing user-message sender attribution.
 *
 * THIS FILE IS CLIENT-SAFE.
 *
 * Why a dedicated module instead of `lib/prompt.ts`?
 *
 * The webapp's client components (e.g. `message-formatter.ts` →
 * `SessionPageClient.tsx`) need the canonical sender-type list to derive a
 * regex for `stripSenderPrefix`. Importing it from
 * `@remote-swe-agents/agent-core/lib` pulls in the whole barrel
 * (`src/lib/index.ts`), which transitively re-exports server-only modules
 * (`messages.ts` uses `fs`, `slack.ts` uses `fs.readFileSync`,
 * `confirm-send-to-user` uses `fs`). Next.js's client bundler then tries to
 * resolve `child_process` / `fs` / `net` / `tls` for the browser and
 * `npm run build` fails.
 *
 * To keep client bundles clean, anything client-safe MUST live in a leaf
 * module that does NOT import from `lib/`. This file fits that contract:
 * it has no runtime imports at all.
 *
 * Adding a new sender type? Append it here and:
 *   - `UserMessageSenderType` (the union) extends automatically
 *   - the webapp's `stripSenderPrefix` regex extends automatically
 *     (it derives the alternation from `USER_MESSAGE_SENDER_TYPES`)
 *   - the LLM envelope `[from: ... (TYPE)]` accepts the new type via
 *     `renderUserMessage` in `lib/prompt.ts` because it imports the
 *     same union from here.
 */

/**
 * Canonical list of supported sender types for the `[from: ... (TYPE)]`
 * envelope header. `as const` so consumers can index the tuple type-safely
 * and so it survives unchanged through bundlers as a frozen literal array.
 */
export const USER_MESSAGE_SENDER_TYPES = ['slack', 'webapp', 'apikey'] as const;
export type UserMessageSenderType = (typeof USER_MESSAGE_SENDER_TYPES)[number];

/**
 * Information about the sender of a user message. Used to annotate the
 * message body with a `[from: ...]` header so the LLM can reliably
 * distinguish between multiple humans talking in the same session (e.g.
 * Slack thread with several participants, webapp users switching accounts,
 * REST API key calls, etc.).
 */
export type UserMessageSender = {
  /** Where the message originated. */
  type: UserMessageSenderType;
  /** Stable sender ID (Slack user ID, Cognito sub, API key id, etc.). */
  id: string;
  /** Human-readable display name. Falls back to `id` when omitted. */
  displayName?: string;
};
