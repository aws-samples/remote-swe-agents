import { useCallback, useEffect, useRef, useState } from 'react';

interface ScrollPositionOptions {
  threshold?: number;
  bottomPixelThreshold?: number;
}

export function useScrollPosition(options: ScrollPositionOptions = {}) {
  const { threshold = 80, bottomPixelThreshold = 150 } = options;
  const [isBottom, setIsBottom] = useState(true);
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);
  const [lastScrollY, setLastScrollY] = useState(0);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const rafRef = useRef<number>(0);
  const lastScrollYRef = useRef(0);

  const handleScroll = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      const currentScrollY = window.scrollY;
      const prevScrollY = lastScrollYRef.current;

      // Header visibility logic
      if (currentScrollY > prevScrollY && currentScrollY > threshold) {
        setIsHeaderVisible(false);
      } else {
        setIsHeaderVisible(true);
      }
      setLastScrollY(currentScrollY);
      lastScrollYRef.current = currentScrollY;

      // Bottom detection logic using pixel-based threshold
      const maxScroll = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      const distanceFromBottom = maxScroll - currentScrollY;
      const newIsBottom = maxScroll <= 0 || distanceFromBottom <= bottomPixelThreshold;

      setIsBottom((prev) => (prev !== newIsBottom ? newIsBottom : prev));

      // Track if user intentionally scrolled up
      if (currentScrollY < prevScrollY && !newIsBottom) {
        setUserScrolledUp(true);
      } else if (newIsBottom) {
        setUserScrolledUp(false);
      }
    });
  }, [threshold, bottomPixelThreshold]);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [handleScroll]);

  return { isBottom, isHeaderVisible, userScrolledUp };
}
