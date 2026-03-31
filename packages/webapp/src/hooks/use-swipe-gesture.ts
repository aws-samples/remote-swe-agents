import { useEffect, useRef } from 'react';

interface SwipeGestureOptions {
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  minSwipeDistance?: number;
  maxVerticalDeviation?: number;
}

function isInsideScrollableElement(element: EventTarget | null): boolean {
  let el = element as HTMLElement | null;
  while (el) {
    if (el.dataset?.scrollable === 'true' || el.scrollWidth > el.clientWidth) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return !!selection && selection.toString().length > 0;
}

export function useSwipeGesture({
  onSwipeRight,
  onSwipeLeft,
  minSwipeDistance = 50,
  maxVerticalDeviation = 100,
}: SwipeGestureOptions) {
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const ignoreSwipe = useRef(false);

  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
      ignoreSwipe.current = isInsideScrollableElement(e.target);
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (ignoreSwipe.current) return;

      // Skip swipe if user is selecting text
      if (hasTextSelection()) return;

      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartX.current;
      const deltaY = Math.abs(touch.clientY - touchStartY.current);

      if (deltaY > maxVerticalDeviation) return;

      if (deltaX > minSwipeDistance && onSwipeRight) {
        onSwipeRight();
      }

      if (deltaX < -minSwipeDistance && onSwipeLeft) {
        onSwipeLeft();
      }
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [onSwipeRight, onSwipeLeft, minSwipeDistance, maxVerticalDeviation]);
}
