import { unstable_isUnrecognizedActionError } from 'next/navigation';

/**
 * Recovery helpers for "version skew" failures: a browser tab that loaded an
 * older build keeps POSTing Server Action IDs (and lazily fetching JS chunks)
 * that no longer exist after the webapp is redeployed. Next.js salts every
 * Server Action ID with a per-build random encryption key, so a redeploy
 * invalidates ALL action IDs held by open tabs — the server answers
 * 404 + `x-nextjs-action-not-found` and the client throws
 * `UnrecognizedActionError` without ever executing the action.
 *
 * Two distinct failure classes with different guarantees:
 *
 * - `isStaleActionError` (UnrecognizedActionError): the server rejected the
 *   action ID BEFORE executing it, so the action is guaranteed not to have
 *   run. This is the only class where an automatic re-submission after a
 *   reload can never cause a double-send.
 * - `isChunkLoadError`: a JS/CSS chunk of the old build failed to load. This
 *   says nothing about whether an in-flight action executed, so callers must
 *   never auto-resubmit on this class — at most reload (the page is already
 *   broken) or restore the user's input without submitting.
 */

const RELOAD_GUARD_KEY = 'stale-deployment-reload-guard';
export const RELOAD_GUARD_WINDOW_MS = 30_000;
/** Hard cap on automatic reload attempts within one "episode" (S3). */
export const RELOAD_MAX_ATTEMPTS = 3;
/** After this long without another reload attempt, the attempt counter resets. */
export const RELOAD_ATTEMPTS_RESET_MS = 10 * 60_000;
/**
 * How recently a reload must have been initiated for the global listener to
 * treat a stale error as "a form-level recovery handler is already reloading
 * this page" and stay silent instead of showing its own notice.
 */
export const FORM_RECOVERY_IN_FLIGHT_MS = 2_000;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError' || name === 'CssChunkLoadError') return true;
  return typeof message === 'string' && /Loading (?:CSS )?chunk .+ failed/i.test(message);
}

/**
 * True when the error is Next.js's UnrecognizedActionError — the server
 * received a Server Action ID it does not know (stale build after a
 * redeploy) and rejected the request with 404 before executing anything.
 *
 * NOTE: `unstable_isUnrecognizedActionError` is an unstable Next.js API
 * (added in Next 15/16 for exactly this version-skew scenario). When
 * upgrading Next.js, verify it still exists and still matches the error
 * thrown by the Server Action client reference on 404 +
 * `x-nextjs-action-not-found`.
 */
export function isStaleActionError(error: unknown): boolean {
  return unstable_isUnrecognizedActionError(error);
}

type ReloadGuardState = { at: number; count: number };

function readGuard(storage: KeyValueStorage): ReloadGuardState | null {
  const raw = storage.getItem(RELOAD_GUARD_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { at, count } = parsed as { at?: unknown; count?: unknown };
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    return { at, count: typeof count === 'number' && Number.isFinite(count) ? count : 1 };
  } catch {
    return null;
  }
}

/**
 * Whether an automatic reload is currently allowed. Two independent brakes
 * prevent reload loops:
 *  1. a sliding window (`RELOAD_GUARD_WINDOW_MS`) between attempts, and
 *  2. a hard cap (`RELOAD_MAX_ATTEMPTS`) on attempts per episode — without
 *     it, an environment that keeps serving the stale HTML from cache could
 *     reload every 30 seconds indefinitely.
 * The episode ends (counter resets) after `RELOAD_ATTEMPTS_RESET_MS` without
 * attempts, or when `clearStaleDeploymentReloadGuard` is called on a
 * successful submission.
 */
export function canReloadForStaleDeployment(storage: KeyValueStorage, now = Date.now()): boolean {
  try {
    const guard = readGuard(storage);
    if (!guard) return true;
    if (now - guard.at >= RELOAD_ATTEMPTS_RESET_MS) return true;
    if (now - guard.at < RELOAD_GUARD_WINDOW_MS) return false;
    return guard.count < RELOAD_MAX_ATTEMPTS;
  } catch {
    return false;
  }
}

export function markStaleDeploymentReload(storage: KeyValueStorage, now = Date.now()): void {
  try {
    const guard = readGuard(storage);
    const count = guard && now - guard.at < RELOAD_ATTEMPTS_RESET_MS ? guard.count + 1 : 1;
    storage.setItem(RELOAD_GUARD_KEY, JSON.stringify({ at: now, count } satisfies ReloadGuardState));
  } catch {}
}

/** Reset the reload attempt counter, e.g. after a successful submission. */
export function clearStaleDeploymentReloadGuard(storage: KeyValueStorage): void {
  try {
    storage.removeItem(RELOAD_GUARD_KEY);
  } catch {}
}

function isFormRecoveryReloadInFlight(storage: KeyValueStorage, now: number): boolean {
  try {
    const guard = readGuard(storage);
    return guard !== null && now - guard.at >= 0 && now - guard.at < FORM_RECOVERY_IN_FLIGHT_MS;
  } catch {
    return false;
  }
}

export type StaleDeploymentDecision = 'ignore' | 'defer' | 'reload' | 'notify';

/**
 * Decide how the GLOBAL listener should react to an uncaught error. This is
 * deliberately conservative: forms that persist their pending submission
 * (MessageForm / NewSessionForm) run their own reload + auto-resend, while
 * every other surface must never be reloaded automatically on a stale action
 * error — an automatic reload would silently destroy unsaved user input
 * (e.g. a long system prompt in CustomAgentForm).
 *
 * - 'ignore': not a stale-deployment error; let default handling proceed.
 * - 'defer': a form-level recovery handler already initiated a reload for
 *   this failure; stay silent.
 * - 'reload': ChunkLoadError only — the page is already broken (missing
 *   code), so reloading cannot lose more than staying broken would.
 * - 'notify': tell the user the app was updated and offer a manual reload;
 *   never reload for them. Also the fallback when the reload guard blocks a
 *   ChunkLoadError reload, so repeated failures always produce visible
 *   feedback instead of a dead button.
 */
export function classifyStaleDeploymentError(
  error: unknown,
  storage: KeyValueStorage,
  now = Date.now()
): StaleDeploymentDecision {
  const chunk = isChunkLoadError(error);
  if (!chunk && !isStaleActionError(error)) return 'ignore';
  if (isFormRecoveryReloadInFlight(storage, now)) return 'defer';
  if (chunk) return canReloadForStaleDeployment(storage, now) ? 'reload' : 'notify';
  return 'notify';
}

/**
 * Reload the page once to recover from a stale deployment. Returns true when
 * the reload was initiated, false when it was suppressed by the loop guard.
 * Callers that get `false` should fall back to their normal error handling.
 */
export function reloadForStaleDeployment(): boolean {
  if (typeof window === 'undefined') return false;
  const storage = window.sessionStorage;
  if (!canReloadForStaleDeployment(storage)) return false;
  markStaleDeploymentReload(storage);
  window.location.reload();
  return true;
}
