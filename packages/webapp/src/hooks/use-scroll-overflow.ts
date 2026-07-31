'use client';

import { useEffect, useRef, useCallback } from 'react';

export function useScrollOverflow<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflowing = el.scrollWidth > el.clientWidth + 1;
    el.dataset.overflowing = String(overflowing);
    if (!overflowing) {
      delete el.dataset.atStart;
      delete el.dataset.atEnd;
      return;
    }
    el.dataset.atStart = String(el.scrollLeft <= 1);
    el.dataset.atEnd = String(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    update();
    el.addEventListener('scroll', update, { passive: true });

    const ro = new ResizeObserver(update);
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [update]);

  return ref;
}
