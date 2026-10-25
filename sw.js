// Offline support: the app shell and libraries are cached; notebook data is
// cached by the app itself (IndexedDB), so GitHub API calls pass straight through.
const VERSION = 'labnote-v1';
const SHELL = [
  './', 'index.html', 'css/notebook.css', 'manifest.webmanifest',
  'js/app.js', 'js/store.js', 'js/model.js', 'js/render.js', 'js/search.js', 'js/util.js', 'js/demo.js',
  'icons/favicon.svg', 'icons/icon-192.png',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // Network first so updates arrive promptly; fall back to the cached copy offline.
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await Promise.race([fetch(req), timeout(5000)]);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
      }
    })());
  } else if (CDN_HOSTS.includes(url.hostname)) {
    // Versioned libraries and fonts never change: cache first.
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    })());
  }
});
