/**
 * @file Cross-component "an event was probably missed" signal.
 *
 * AppSync Events has no replay, so a realtime event published while the
 * socket was momentarily down is lost. `RefreshOnFocus` normally throttles
 * the focus-triggered `router.refresh()` to once per 60s to avoid expensive
 * RSC re-fetches on every mobile app-switch. But when a consumer has concrete
 * evidence that a drawing event was dropped (e.g. an unread count increased,
 * or a `lastMessageUpdate` preview had no matching bubble on screen), the
 * next focus should reconcile immediately instead of waiting out the
 * throttle.
 *
 * This module is a tiny process-global latch: consumers `raise()` the signal
 * when they detect a probable miss, and `RefreshOnFocus` calls
 * `consume()` on focus to atomically read-and-clear it. Kept dependency-free
 * (no React, no server imports) so any client component can use it and so it
 * never affects the bundle.
 */

let missed = false;

/**
 * Mark that a realtime event was probably missed and a full reconciliation is
 * warranted on the next focus. Idempotent.
 */
export function raiseMissedEvents(): void {
  missed = true;
}

/**
 * Clear the signal without consuming it as a focus trigger. Used to cancel a
 * raise that turned out to be a false positive -- most importantly the
 * unread-count race: the server emits `unreadUpdate(count > 0)` on every
 * delivery, which almost always beats the client's async mark-as-read
 * round-trip, so a positive count alone is NOT evidence of a miss. The
 * follow-up `unreadUpdate(count === 0)` echo from a completed mark-as-read
 * calls this to undo the raise. A genuine miss never marks read (the drawing
 * event was never received), so the count stays > 0 and the raise survives.
 */
export function clearMissedEvents(): void {
  missed = false;
}

/**
 * Atomically read and clear the signal. Returns `true` exactly once per
 * `raiseMissedEvents()` window: the first caller after a raise gets `true`,
 * subsequent callers get `false` until the signal is raised again.
 */
export function consumeMissedEvents(): boolean {
  const wasMissed = missed;
  missed = false;
  return wasMissed;
}
