import { useCallback, useEffect, useRef, useState } from 'react';

interface ScrollPositionOptions {
  threshold?: number;
  bottomThreshold?: number;
}

export function useScrollPosition(options: ScrollPositionOptions = {}) {
  const { threshold = 80, bottomThreshold = 0.95 } = options;
  const [isBottom, setIsBottom] = useState(false);
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);
  const [lastScrollY, setLastScrollY] = useState(0);
  const rafRef = useRef<number>(0);

  const handleScroll = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      const currentScrollY = window.scrollY;

      // Header visibility logic
      if (currentScrollY > lastScrollY && currentScrollY > threshold) {
        setIsHeaderVisible(false);
      } else {
        setIsHeaderVisible(true);
      }
      setLastScrollY(currentScrollY);

      // Bottom detection logic
      const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      const windowScroll = document.documentElement.scrollTop;
      const scrolled = height > 0 ? windowScroll / height : 0;

      const newIsBottom = scrolled > bottomThreshold;
      setIsBottom((prev) => (prev !== newIsBottom ? newIsBottom : prev));
    });
  }, [lastScrollY, threshold, bottomThreshold]);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [handleScroll]);

  return { isBottom, isHeaderVisible };
}
