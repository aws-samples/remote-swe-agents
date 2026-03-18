import { useEffect, useRef } from 'react';

interface SwipeGestureOptions {
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  minSwipeDistance?: number;
  maxVerticalDeviation?: number;
}

export function useSwipeGesture({
  onSwipeRight,
  onSwipeLeft,
  minSwipeDistance = 50,
  maxVerticalDeviation = 100,
}: SwipeGestureOptions) {
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);

  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
    };

    const handleTouchEnd = (e: TouchEvent) => {
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
