import { useState, useEffect } from 'react';

/**
 * A hook that returns whether the current viewport is mobile-sized
 * @returns {boolean} true if the viewport width is less than or equal to 768px
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkIsMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    // Check on mount
    checkIsMobile();

    // Add event listener for window resize
    window.addEventListener('resize', checkIsMobile);

    // Clean up
    return () => {
      window.removeEventListener('resize', checkIsMobile);
    };
  }, []);

  return isMobile;
}
