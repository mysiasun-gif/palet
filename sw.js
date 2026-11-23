// Palet service worker: offline app shell, cached fonts, reminder notification clicks.
const VERSION = 'palet-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];
const FONT_CACHE = 'palet-fonts';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate: open instantly from cache, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const key = req.mode === 'navigate' ? './index.html' : req;
    const hit = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then(res => {
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { event.waitUntil(network); return hit; }
    const res = await network;
    return res ?? new Response('Çevrimdışısın ve bu dosya önbellekte yok.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const id = event.notification.data?.id;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all[0];
    if (client) {
      await client.focus();
      if (id) client.postMessage({ type: 'open', id });
      return;
    }
    await self.clients.openWindow(id ? `./#/note/${encodeURIComponent(id)}` : './');
  })());
});
