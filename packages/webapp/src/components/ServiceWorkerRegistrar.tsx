'use client';

import { useEffect } from 'react';

/**
 * Registers /sw.js for every visitor. Previously the service worker was only
 * registered when a user enabled push notifications, so most users never
 * benefited from its caching. register() is idempotent for the same script
 * URL, so this does not conflict with the push components that also call it.
 */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Service worker registration failed:', error);
    });
  }, []);

  return null;
}
