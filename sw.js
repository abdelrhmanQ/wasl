// ====================================================================
// sw.js — Service Worker: lets the app OPEN and run with no internet.
// --------------------------------------------------------------------
// Strategy: network-first with cache fallback for same-origin GETs.
//  - Online: every request goes to the network (so updates are always
//    picked up), and the fresh copy is stored in the cache.
//  - Offline: the cached copy is served instead, so the app shell
//    (HTML/JS/CSS/logo/Supabase lib) loads and the login falls back to
//    the last signed-in account (see main.js offlineLastUser()).
// Supabase API calls are cross-origin, so they bypass this worker and
// fail naturally offline — which is what triggers the outbox queueing.
// ====================================================================
const CACHE = 'wasl-app-v9';
const CORE = [
  './',
  'index.html',
  'main.js',
  'server.supabase.js',
  'style.css',
  'sports.html',
  'manifest.json',
  'vendor/supabase.min.js',
  'vendor/qrcode.min.js',
  'vendor/jsbarcode.min.js',
  'src/logo-after.png',
  'src/logo-after.ico',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches
      .open(CACHE)
      // Cache each core file independently: one missing/renamed file must not
      // abort the whole install (addAll is all-or-nothing).
      .then(c => Promise.allSettled(CORE.map(u => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only handle same-origin GETs (app files). API/CDN calls go straight out.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache the fresh copy for offline use (clone: a response body can
        // only be read once).
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then(hit => {
          if (hit) return hit;
          // Unknown navigation while offline -> serve the app shell.
          if (e.request.mode === 'navigate') return caches.match('index.html');
          return Response.error();
        }),
      ),
  );
});
