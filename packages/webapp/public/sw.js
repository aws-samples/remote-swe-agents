self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    const options = {
      body: data.body || '',
      icon: '/icon-192x192.png',
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
      const totalUnread = (badgeInfo.pendingCount || 0) + (badgeInfo.hasOtherUnread ? 1 : 0);
      if (totalUnread > 0) {
        badgePromise = self.navigator.setAppBadge(totalUnread);
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
      const totalUnread = (badgeInfo?.pendingCount || 0) + (badgeInfo?.hasOtherUnread ? 1 : 0);
      if (totalUnread > 0) {
        self.navigator.setAppBadge(totalUnread);
      } else if ('clearAppBadge' in self.navigator) {
        self.navigator.clearAppBadge();
      }
    }
  }
});

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});
