// Service worker : réception des notifications push et ouverture de l'annonce.
const CACHE = 'nick-immobilier-v3';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/img/banner.webp'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

// Réseau d'abord, cache en secours (pour l'interface uniquement, jamais l'API).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('/'))),
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'Nick Immobilier', body: 'Nouvelle annonce', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }
  const options = {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || '/' },
    image: data.image || undefined,
  };
  // iOS exige qu'une notification soit affichée à chaque push, sinon
  // l'abonnement est révoqué au bout de quelques envois silencieux.
  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    (async () => {
      const external = /^https?:/.test(target) && !target.startsWith(self.location.origin);
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (!external) {
        for (const client of all) {
          if ('focus' in client) {
            await client.focus();
            if ('navigate' in client) await client.navigate(target);
            return;
          }
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // L'abonnement a été renouvelé par le navigateur : on prévient le serveur.
  event.waitUntil(
    (async () => {
      const sub = event.newSubscription || (await self.registration.pushManager.getSubscription());
      if (!sub) return;
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      }).catch(() => {});
    })(),
  );
});
