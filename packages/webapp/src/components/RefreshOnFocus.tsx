'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { consumeMissedEvents } from '@/lib/missed-events-signal';

/**
 * Minimum interval between focus-triggered refreshes. router.refresh()
 * re-fetches the whole RSC payload of the current page, which is expensive
 * on mobile (every app switch fires a focus event). Realtime events keep the
 * UI current in between; this refresh only exists to reconcile events missed
 * while the tab was hidden.
 */
const MIN_REFRESH_INTERVAL_MS = 60_000;

export function RefreshOnFocus() {
  const { refresh } = useRouter();
  // The page itself was just fetched, so treat mount time as the last refresh.
  // Initialized in the mount effect below rather than inline (`Date.now()` is
  // impure and must not run during render).
  const lastRefreshAtRef = useRef(0);

  useEffect(() => {
    lastRefreshAtRef.current = Date.now();

    const onFocus = () => {
      const now = Date.now();
      // Bypass the throttle when a consumer has concrete evidence that a
      // realtime event was dropped (e.g. an unread count rose while hidden).
      // AppSync Events has no replay, so waiting out the full 60s throttle
      // would leave the UI stale that whole time; a missed-event signal means
      // reconciling now is worth the RSC re-fetch. `consumeMissedEvents`
      // atomically read-and-clears, so a stale flag can't force repeated
      // refreshes on every subsequent focus.
      const missed = consumeMissedEvents();
      if (!missed && now - lastRefreshAtRef.current < MIN_REFRESH_INTERVAL_MS) {
        return;
      }
      lastRefreshAtRef.current = now;
      refresh();
    };

    window.addEventListener('focus', onFocus);

    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return null;
}
