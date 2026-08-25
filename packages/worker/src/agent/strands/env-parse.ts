/**
 * Shared env parsing for the strands kiro-acp modules (watchdog-controller,
 * kiro-acp-agent, proc-liveness, kiro-agent-pool). Consolidates what used to be
 * three near-identical `parseMsEnv` copies + several inline boolean off-form
 * checks into one place.
 */

/**
 * Parse a non-negative integer (milliseconds) from an env var, falling back to
 * `fallbackMs` when the var is unset / empty / not a finite, non-negative
 * number.
 */
export const parseMsEnv = (name: string, fallbackMs: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallbackMs;
};

/**
 * Parse a boolean-ish env var whose DEFAULT is ON. Returns false only for the
 * explicit off-forms `0` / `false` / `off` / `no` (case-insensitive); unset,
 * empty, or any other value → true. Used by the default-ON feature toggles
 * (cancel probe, proc liveness, process reuse).
 */
export const parseBoolEnvDefaultOn = (name: string): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
};
