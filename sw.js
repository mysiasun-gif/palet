// Palet service worker: offline app shell, cached fonts, reminder notification clicks.
const VERSION = 'palet-v9';
const SHELL = [
  './',
  './index.html',
  './kvkk.html',
  './styles.css',
  './app.js',
  './cloud.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/logo.png',
];
// Standalone pages that open by navigation; any other navigation opens the app.
const PAGES = ['./kvkk.html'];
const FONT_CACHE = 'palet-fonts';
// Google sign-in and Drive: always straight to the network, never cached.
const GOOGLE_HOSTS = ['accounts.google.com', 'apis.google.com', 'www.googleapis.com'];

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
  const url = new URL(req.url);
  if (GOOGLE_HOSTS.includes(url.hostname)) return;
  if (req.method !== 'GET') return;

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
    // A page navigation opens its own page from the shell (kvkk.html), everything else the app.
    const key = req.mode === 'navigate' ? (PAGES.find(p => url.pathname.endsWith(p.slice(1))) ?? './index.html') : req;
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
