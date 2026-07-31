import { useEffect, useRef } from 'react';

let lockCount = 0;
let savedScrollY = 0;

function lock() {
  if (lockCount === 0) {
    savedScrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.overflow = 'hidden';
  }
  lockCount++;
}

function unlock() {
  lockCount--;
  if (lockCount <= 0) {
    lockCount = 0;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.overflow = '';
    window.scrollTo(0, savedScrollY);
  }
}

export function useBodyScrollLock(active: boolean) {
  const wasActive = useRef(false);

  useEffect(() => {
    if (active && !wasActive.current) {
      lock();
      wasActive.current = true;
    } else if (!active && wasActive.current) {
      unlock();
      wasActive.current = false;
    }
    return () => {
      if (wasActive.current) {
        unlock();
        wasActive.current = false;
      }
    };
  }, [active]);
}
