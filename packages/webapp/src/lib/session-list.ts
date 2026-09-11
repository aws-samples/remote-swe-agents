import { SessionItem } from '@remote-swe-agents/agent-core/schema';
import { extractUserMessage } from './message-formatter';

/**
 * Maximum length of the initialMessage preview shipped to the client.
 * Session list surfaces render at most a single truncated line
 * (`lastMessage || initialMessagePreview`), so anything beyond this length
 * is never displayed.
 */
export const SESSION_PREVIEW_MAX_LENGTH = 200;

/**
 * A SessionItem shrunk for list/sidebar rendering. The full `initialMessage`
 * is replaced by `initialMessagePreview` so the type system distinguishes
 * "already truncated for display" from the raw DB item — code that needs the
 * full message cannot accidentally receive a truncated one.
 */
export type SessionListItem = Omit<SessionItem, 'initialMessage'> & {
  initialMessagePreview: string;
};

/**
 * Extract the user-visible part of an initial message and truncate it to the
 * preview length. Shared by every SSR surface that serializes a one-line
 * session preview (sessions list, sidebar, cost page, custom agent page).
 */
export function toInitialMessagePreview(initialMessage: string): string {
  return extractUserMessage(initialMessage).slice(0, SESSION_PREVIEW_MAX_LENGTH);
}

/**
 * Shrink a SessionItem for list/sidebar rendering.
 *
 * `initialMessage` can be several KB per session (full task prompts). With
 * hundreds of sessions this dominated the /sessions RSC payload (~85% of
 * ~3MB measured in prod), making the page unusable on slow mobile networks.
 * The list UI only needs a one-line preview, so we extract the user-visible
 * part server-side and truncate it before the item crosses the RSC boundary.
 */
export function toSessionListItem(session: SessionItem): SessionListItem {
  const { initialMessage, ...rest } = session;
  return {
    ...rest,
    initialMessagePreview: toInitialMessagePreview(initialMessage),
  };
}

export function toSessionListItems(sessions: SessionItem[]): SessionListItem[] {
  return sessions.map(toSessionListItem);
}
