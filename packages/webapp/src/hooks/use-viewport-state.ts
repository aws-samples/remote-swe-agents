import { useEffect, useState } from 'react';

export const KEYBOARD_OPEN_VIEWPORT_DELTA_PX = 100;
export const PINCH_ZOOM_SCALE_THRESHOLD = 1.01;

export function useViewportState(): { isDisplaced: boolean } {
  const [isDisplaced, setIsDisplaced] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const heightDelta = window.innerHeight - vv.height;
      const isKeyboardOpen = vv.scale <= PINCH_ZOOM_SCALE_THRESHOLD && heightDelta > KEYBOARD_OPEN_VIEWPORT_DELTA_PX;
      const isPinchZoomed = vv.scale > PINCH_ZOOM_SCALE_THRESHOLD;
      const displaced = isKeyboardOpen || isPinchZoomed;
      setIsDisplaced((prev) => (prev === displaced ? prev : displaced));
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return { isDisplaced };
}
