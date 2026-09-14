import type { KeyValueStorage } from './deployment-recovery';

/**
 * Persistence for a form submission that failed because the page was running
 * a stale (pre-redeploy) build. The payload survives the automatic page
 * reload via sessionStorage (per-tab, so another tab of the same session can
 * never pick it up and double-send) and is consumed exactly once by
 * `takePendingResend` right after the reload.
 *
 * `mode` controls what the consumer may do with the payload:
 *  - 'resend': automatically re-submit on the fresh build. Only ever written
 *    for UnrecognizedActionError failures, where the server is guaranteed
 *    NOT to have executed the action — so the retry cannot double-send.
 *  - 'restore': repopulate the form (text + attachments) but let the user
 *    press send themselves. Used for ChunkLoadError, where nothing proves
 *    the original action did not execute.
 * Unknown or missing modes parse as 'restore': when in doubt, preserve the
 * data but never auto-submit.
 *
 * Attachments are persisted as S3 object keys, not bytes: uploads happen via
 * pre-signed PUT before submission, so the objects already live in S3 and
 * keys alone are sufficient to restore them across a reload.
 */

export type PendingResendMode = 'resend' | 'restore';

export type PendingResendPayload<T> = {
  mode: PendingResendMode;
  values: T;
  clientId?: string;
  savedAt: number;
};

export const PENDING_RESEND_MAX_AGE_MS = 5 * 60_000;

const keyFor = (formId: string) => `pending-resend-${formId}`;

function defaultStorage(): KeyValueStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function parsePendingResend<T>(raw: string | null, now = Date.now()): PendingResendPayload<T> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as { mode?: unknown; values?: unknown; clientId?: unknown; savedAt?: unknown };
    if (typeof candidate.savedAt !== 'number') return null;
    if (!candidate.values || typeof candidate.values !== 'object') return null;
    if (now - candidate.savedAt > PENDING_RESEND_MAX_AGE_MS) return null;
    if (candidate.clientId !== undefined && typeof candidate.clientId !== 'string') return null;
    return {
      mode: candidate.mode === 'resend' ? 'resend' : 'restore',
      values: candidate.values as T,
      clientId: candidate.clientId,
      savedAt: candidate.savedAt,
    };
  } catch {
    return null;
  }
}

export function savePendingResend<T>(
  formId: string,
  payload: { mode: PendingResendMode; values: T; clientId?: string },
  storage: KeyValueStorage | null = defaultStorage(),
  now = Date.now()
): void {
  if (!storage) return;
  try {
    storage.setItem(keyFor(formId), JSON.stringify({ ...payload, savedAt: now } satisfies PendingResendPayload<T>));
  } catch {}
}

export function takePendingResend<T>(
  formId: string,
  storage: KeyValueStorage | null = defaultStorage(),
  now = Date.now()
): PendingResendPayload<T> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(keyFor(formId));
    if (raw !== null) storage.removeItem(keyFor(formId));
    return parsePendingResend<T>(raw, now);
  } catch {
    return null;
  }
}

/**
 * Non-consuming existence check. Used by the draft-attachments restore to
 * detect that a stale-deployment recovery payload owns this mount's
 * attachment state (the consume effect will restore or resubmit them),
 * without disturbing the take-before-submit invariant.
 */
export function hasPendingResend(
  formId: string,
  storage: KeyValueStorage | null = defaultStorage(),
  now = Date.now()
): boolean {
  if (!storage) return false;
  try {
    return parsePendingResend(storage.getItem(keyFor(formId)), now) !== null;
  } catch {
    return false;
  }
}

/** Best-effort extraction of a string array from an untrusted persisted value. */
export function extractStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Salvage optional fields of a persisted payload one by one against the
 * CURRENT build's schema shape. A resend crosses a deployment boundary, so a
 * single drifted enum (e.g. a removed model id) must only drop THAT field —
 * not drag valid siblings like `customAgentId` or `inferenceMode` down with
 * it. Returns the fields that parsed successfully (undefined results are
 * omitted) plus the names of the fields that had to be dropped, so callers
 * can tell the user which settings could not be carried over.
 */
export function salvageOptionalFields<T extends Record<string, { safeParse: (value: unknown) => SafeParseLike }>>(
  shape: T,
  raw: Record<string, unknown>,
  fields: (keyof T & string)[]
): { values: Record<string, unknown>; dropped: string[] } {
  const values: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const field of fields) {
    const parsed = shape[field].safeParse(raw[field]);
    if (parsed.success) {
      if (parsed.data !== undefined) values[field] = parsed.data;
    } else {
      dropped.push(field);
    }
  }
  return { values, dropped };
}

type SafeParseLike = { success: true; data: unknown } | { success: false };
