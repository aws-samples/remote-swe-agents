import { useEffect, useState } from 'react';

export function useScrollPosition() {
  const [scrollPosition, setScrollPosition] = useState(0);

  function handleScroll() {
    const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;

    const windowScroll = document.documentElement.scrollTop;

    const scrolled = windowScroll / height;

    setScrollPosition(scrolled);
  }

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  });

  return scrollPosition;
}
