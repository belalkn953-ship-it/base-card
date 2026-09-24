const CACHE = 'base-card-shell-v2';
const BASE = new URL('./', self.location.href);
const SHELL = [BASE.href, new URL('styles.css', BASE).href, new URL('manifest.webmanifest', BASE).href];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(url => cache.add(url).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
  })());
});

// Cache only same-origin static files; never cache API/auth responses.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const scopePath = new URL(self.registration.scope).pathname;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath)) return;
  if (!/\.(?:css|js|png|jpe?g|webp|svg|ico|webmanifest|woff2?)$/i.test(url.pathname)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return await caches.match(request) || Response.error();
    }
  })());
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data?.text() || '' }; }
  const scope = new URL(self.registration.scope);
  let target = new URL(data.url || 'admin.html', scope);
  if (target.origin !== self.location.origin || !target.pathname.startsWith(scope.pathname)) {
    target = new URL('admin.html', scope);
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Base Card', {
    body: data.body || 'وصل إشعار جديد إلى الإدارة.',
    icon: new URL('icon-192.png', scope).href,
    badge: new URL('icon-192.png', scope).href,
    tag: data.tag || `base-card-${Date.now()}`,
    vibrate: [250, 100, 250],
    data: { url: target.href },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const scope = new URL(self.registration.scope);
  let target = new URL(event.notification.data?.url || 'admin.html', scope);
  if (target.origin !== self.location.origin || !target.pathname.startsWith(scope.pathname)) {
    target = new URL('admin.html', scope);
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(target.href);
        return await client.focus();
      }
    }
    return await self.clients.openWindow(target.href);
  })());
});
