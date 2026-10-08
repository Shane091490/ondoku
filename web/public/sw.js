// Ondoku service worker: offline app shell, recently opened articles and their images.
// API data uses network-first (fresh when online, cached copy when not); audio is never cached here. Pictures (saved
// on the server or still on their sites) are cache-first.
const VERSION = 'v1';
const SHELL = `readlog-shell-${VERSION}`;
const DATA = `readlog-data-${VERSION}`;
const IMAGES = `readlog-img-${VERSION}`;
const ASSETS = `readlog-assets-${VERSION}`; // built files (hashed names): a few releases' worth are kept
const MAX_IMAGES = 400;
const MAX_ARTICLES = 150;
const MAX_ASSETS = 120;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/theme-init.js'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))))
    // Built files used to be kept with the app shell, where they piled up release after release.
    .then(() => caches.open(SHELL)).then((c) => c.keys().then((reqs) => Promise.all(reqs.filter((r) => new URL(r.url).pathname.startsWith('/assets/')).map((r) => c.delete(r)))))
    .then(() => self.clients.claim()));
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

async function networkFirst(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) { cache.put(req, res.clone()); if (max) trim(cacheName, max); }
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: false }) || await cache.match(req.url.split('?')[0]);
    if (hit) return hit;
    return new Response(JSON.stringify({ error: 'You are offline and this page has not been saved on this device yet' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    // Public share pages, sign-in redirects and the share target aren't the app: leave them to the network, so they
    // never replace the cached app shell.
    if (/^\/(s|auth|api)\//.test(url.pathname) || url.pathname === '/share') return;
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(SHELL).then((c) => c.put('/', copy)); }
      return res;
    }).catch(() => caches.match('/')));
    return;
  }
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/assets/')) {
      e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(ASSETS).then((c) => c.put(req, copy)).then(() => trim(ASSETS, MAX_ASSETS)); }
        return res;
      })));
      return;
    }
    // Pictures saved on the server never change under the same name: cache-first, like other sites' images below.
    if (/^\/api\/(v1\/)?articles\/\d+\/images\/[\w.]+$/.test(url.pathname)) { e.respondWith(cacheFirstImage(req)); return; }
    if (/^\/api\/(v1\/)?articles\/\d+$/.test(url.pathname)) { e.respondWith(networkFirst(req, DATA, MAX_ARTICLES)); return; }
    if (/^\/api\/(v1\/)?(articles|tags|auth\/status|tts\/status)$/.test(url.pathname)) { e.respondWith(networkFirst(req, DATA)); return; }
    return;
  }
  // Article images from other sites (not saved on the server yet): cache-first so opened articles keep their
  // pictures offline.
  if (req.destination === 'image') e.respondWith(cacheFirstImage(req));
});

function cacheFirstImage(req) {
  return caches.open(IMAGES).then(async (c) => {
    const hit = await c.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); trim(IMAGES, MAX_IMAGES); }
      return res;
    } catch { return Response.error(); }
  });
}
