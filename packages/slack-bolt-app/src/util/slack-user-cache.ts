import { WebClient } from '@slack/web-api';

/**
 * Slack user ID → display name cache.
 *
 * Two separate maps are used so a transient Slack API failure does not
 * permanently poison the cache with a `<@U...>` fallback:
 *
 *   - `cache` holds SUCCESSFUL resolutions with a TTL (`SUCCESS_TTL_MS`).
 *     Display names change infrequently but they DO change (renames,
 *     marriage, account migration), and a process-lifetime cache could keep
 *     a stale name for as long as the Lambda container lives. A 24 h TTL is
 *     a reasonable balance between reducing Slack API traffic and reflecting
 *     name changes within a day. Entries are stored as `{ value, expiresAt }`
 *     so we can evict just-in-time on read without a sweeper.
 *   - `failureBackoff` records the timestamp of the most recent failure for
 *     a given user id. While the backoff window is active we skip the Slack
 *     API and return the `<@U...>` fallback directly, so a storm of messages
 *     does not translate into a storm of failing `users.info` calls. Once
 *     `BACKOFF_MS` has elapsed the next lookup retries the API, so a
 *     transient outage naturally self-heals without requiring a process
 *     recycle.
 */
type CacheEntry = { value: string; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const failureBackoff = new Map<string, number>();
export const BACKOFF_MS = 60_000;
export const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function buildFallback(slackUserId: string): string {
  return `<@${slackUserId}>`;
}

/**
 * Resolve a Slack user ID to a human-readable display name using a
 * TTL-bound success cache with short-window failure backoff.
 *
 * Display-name resolution priority (matches Slack UI conventions):
 *   1. `profile.display_name` when non-empty
 *   2. `profile.real_name` when non-empty
 *   3. `user.real_name`
 *   4. `user.name`
 *   5. `<@{slackUserId}>` fallback so the raw mention is still readable.
 *
 * On API failure, returns the `<@{slackUserId}>` fallback WITHOUT caching it
 * under `cache`. Instead a timestamp is recorded in `failureBackoff` so that
 * subsequent calls within `BACKOFF_MS` short-circuit to the fallback without
 * retrying the API. After the backoff expires, the next call attempts the
 * API again and promotes a successful result into `cache` (also clearing
 * the backoff entry).
 */
export async function resolveSlackDisplayName(client: WebClient, slackUserId: string): Promise<string> {
  if (!slackUserId) return 'unknown-user';

  const now = Date.now();
  const cached = cache.get(slackUserId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached) {
    // Lazy eviction of stale entries so the map does not grow unbounded.
    cache.delete(slackUserId);
  }

  const lastFail = failureBackoff.get(slackUserId);
  if (lastFail !== undefined && now - lastFail < BACKOFF_MS) {
    return buildFallback(slackUserId);
  }

  try {
    const res = await client.users.info({ user: slackUserId });
    const profile = res.user?.profile;
    const display =
      (profile?.display_name && profile.display_name.trim()) ||
      (profile?.real_name && profile.real_name.trim()) ||
      (res.user?.real_name && res.user.real_name.trim()) ||
      res.user?.name ||
      buildFallback(slackUserId);
    cache.set(slackUserId, { value: display, expiresAt: now + SUCCESS_TTL_MS });
    failureBackoff.delete(slackUserId);
    return display;
  } catch (e) {
    console.error(`[slack-user-cache] failed to resolve ${slackUserId}:`, e);
    failureBackoff.set(slackUserId, now);
    return buildFallback(slackUserId);
  }
}

/**
 * For tests only: clear both the success cache and the failure backoff map.
 */
export function __clearSlackUserCacheForTests() {
  cache.clear();
  failureBackoff.clear();
}
