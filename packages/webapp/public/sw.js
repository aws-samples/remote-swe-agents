self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    const options = {
      body: data.body || '',
      icon: data.icon || '/icon-192x192.png',
      badge: '/icon-192x192.png',
      data: {
        url: data.url || '/',
        workerId: data.workerId || '',
      },
      tag: data.workerId || 'default',
      renotify: true,
    };

    const badgeInfo = data.badge;
    let badgePromise = Promise.resolve();
    if ('setAppBadge' in self.navigator && badgeInfo) {
      // Prefer server-computed totalUnread (consistent with the in-app bell
      // badge). Fall back to the legacy pendingCount/hasOtherUnread fields for
      // payloads emitted before totalUnread was introduced.
      const totalUnread =
        typeof badgeInfo.totalUnread === 'number'
          ? badgeInfo.totalUnread
          : (badgeInfo.pendingCount || 0) + (badgeInfo.hasOtherUnread ? 1 : 0);
      if (totalUnread > 0) {
        badgePromise = self.navigator.setAppBadge(totalUnread);
      } else if ('clearAppBadge' in self.navigator) {
        badgePromise = self.navigator.clearAppBadge();
      }
    }

    event.waitUntil(
      Promise.all([self.registration.showNotification(data.title || 'Remote SWE Agents', options), badgePromise])
    );
  } catch (e) {
    console.error('Failed to show notification:', e);
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'UPDATE_BADGE') {
    const badgeInfo = event.data.badge;
    if ('setAppBadge' in self.navigator) {
      // Prefer server-computed totalUnread (consistent with the in-app bell
      // badge). Fall back to the legacy pendingCount/hasOtherUnread fields for
      // payloads emitted before totalUnread was introduced.
      const totalUnread =
        typeof badgeInfo?.totalUnread === 'number'
          ? badgeInfo.totalUnread
          : (badgeInfo?.pendingCount || 0) + (badgeInfo?.hasOtherUnread ? 1 : 0);
      if (totalUnread > 0) {
        self.navigator.setAppBadge(totalUnread);
      } else if ('clearAppBadge' in self.navigator) {
        self.navigator.clearAppBadge();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Caching (added for mobile/slow-network performance)
//
// Strategy per request type:
// - /_next/static/**  : cache-first. Files are content-hashed and immutable,
//   so a cached copy is always correct. Old-build chunks stay cached, which
//   keeps a cached (stale) HTML page functional even offline.
// - navigations (HTML): network-first with a timeout fallback to the last
//   cached copy of the same URL. On a healthy network users always get fresh
//   HTML (no version skew), while offline / very slow connections render the
//   previous page instead of a browser error. Redirected or non-OK responses
//   are never cached so auth redirects (/sign-in) cannot poison the cache
//   (navigation fetches use redirect mode 'manual', so redirects surface as
//   uncacheable opaqueredirect responses). A navigation request for /sign-in
//   itself additionally purges the whole page cache: cached HTML is
//   authenticated content, so it must not outlive the session (sign-out and
//   cookie expiry both funnel into this navigation via the middleware
//   redirect).
// - icons / manifest  : stale-while-revalidate (cosmetic, safe when stale).
// - everything else (API, RSC payload fetches, server actions, cross-origin):
//   network only — deliberately NOT cached. Serving stale HTML on healthy
//   networks (full stale-while-revalidate for navigations) was rejected
//   because right after a deploy it would reference deleted chunks and fight
//   the ChunkLoadError->reload recovery in DeploymentRecoveryListener.
// ---------------------------------------------------------------------------

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const PAGE_CACHE = `pages-${CACHE_VERSION}`;
const ASSET_CACHE = `assets-${CACHE_VERSION}`;
const KNOWN_CACHES = [STATIC_CACHE, PAGE_CACHE, ASSET_CACHE];
const NAVIGATION_NETWORK_TIMEOUT_MS = 3000;
// Growth bounds. Entries are evicted oldest-inserted-first once a cache
// exceeds its limit (Cache.keys() returns entries in insertion order).
const PAGE_CACHE_MAX_ENTRIES = 50;
const STATIC_CACHE_MAX_ENTRIES = 300;
const ASSET_CACHE_MAX_ENTRIES = 50;

const timeout = (ms) =>
  new Promise((resolve) => {
    setTimeout(() => resolve(undefined), ms);
  });

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

function putAndTrim(cache, request, response, maxEntries) {
  cache
    .put(request, response)
    .then(() => trimCache(cache, maxEntries))
    .catch(() => {});
}

// All cached page HTML is authenticated content. When authentication ends —
// observed as a navigation request for /sign-in (sign-out, cookie expiry and
// direct visits all land here via the middleware redirect) — purge it so the
// next visitor on this browser can never be served another user's cached
// pages.
async function purgePageCache() {
  const cache = await caches.open(PAGE_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.map((key) => cache.delete(key)));
}

async function cacheFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && !response.redirected) {
    putAndTrim(cache, request, response.clone(), maxEntries);
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok && !response.redirected) {
        putAndTrim(cache, request, response.clone(), maxEntries);
      }
      return response;
    })
    .catch(() => undefined);
  return cached || (await network) || fetch(request);
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(PAGE_CACHE);
  const networkPromise = fetch(request)
    .then((response) => {
      // Navigation requests have redirect mode 'manual', so an auth redirect
      // surfaces here as an opaqueredirect response (status 0, ok=false,
      // redirected=false) and is never cached by this guard. The sign-out
      // purge happens in the fetch handler when the browser follows the
      // redirect and issues the /sign-in navigation.
      if (response.ok && !response.redirected && new URL(request.url).pathname.indexOf('/api/') !== 0) {
        putAndTrim(cache, request, response.clone(), PAGE_CACHE_MAX_ENTRIES);
      }
      return response;
    })
    .catch(() => undefined);

  // Serve fresh HTML when the network answers quickly; fall back to the last
  // cached copy on slow/offline networks while the fetch keeps running in the
  // background to refresh the cache for next time.
  const winner = await Promise.race([networkPromise, timeout(NAVIGATION_NETWORK_TIMEOUT_MS)]);
  if (winner) return winner;

  const cached = await cache.match(request);
  if (cached) return cached;

  const network = await networkPromise;
  if (network) return network;
  return fetch(request);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE, STATIC_CACHE_MAX_ENTRIES).catch(() => fetch(request)));
    return;
  }

  if (request.mode === 'navigate') {
    // Any navigation that lands on /sign-in means the session is no longer
    // authenticated (sign-out, cookie expiry, and direct visits all converge
    // here: the middleware redirects every unauthenticated navigation to
    // /sign-in, and the browser re-issues that redirect as a fresh navigation
    // request through this handler). Cached page HTML is authenticated
    // content, so drop it all before the next user can be served it.
    if (url.pathname === '/sign-in') {
      event.waitUntil(purgePageCache().catch(() => {}));
    }
    event.respondWith(networkFirstNavigation(request).catch(() => fetch(request)));
    return;
  }

  if (
    url.pathname === '/manifest.json' ||
    url.pathname === '/api/manifest' ||
    url.pathname.startsWith('/api/agent-icon') ||
    /^\/icon-\d+x\d+\.png$/.test(url.pathname)
  ) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE, ASSET_CACHE_MAX_ENTRIES).catch(() => fetch(request)));
    return;
  }
  // All other requests (RSC payload fetches, API calls, ...) fall through to
  // the network untouched.
});

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((key) => !KNOWN_CACHES.includes(key)).map((key) => caches.delete(key)))
        ),
    ])
  );
});
