// Bump this whenever the shell files change together (scan.html now depends
// on signInAnonymously/deleteField exported by firebase-init.js): a new
// name makes the worker re-precache them all as one coherent set, so the
// offline fallback can never pair a new page with an old helper file.
const CACHE_NAME = 'dawaat-scan-v16';
const SHELL_FILES = [
  'scan.html', 'firebase-init.js', 'icons.js', 'utils.js', 'vendor/qr-scanner.umd.min.js', 'vendor/qr-scanner-worker.min.js', 'icons/logo.svg',
  'fonts/ibm-plex-sans-arabic-400-arabic.woff2', 'fonts/ibm-plex-sans-arabic-400-latin.woff2', 'fonts/ibm-plex-sans-arabic-500-arabic.woff2', 'fonts/ibm-plex-sans-arabic-500-latin.woff2', 'fonts/ibm-plex-sans-arabic-700-arabic.woff2', 'fonts/ibm-plex-sans-arabic-700-latin.woff2', 'fonts/playfair-display-700-latin.woff2', 'fonts/reem-kufi-700-arabic.woff2', 'fonts/reem-kufi-700-latin.woff2'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first (short timeout, falling back to cache) for the static shell
// only — Firestore and auth calls, and everything else, always go straight
// to the network, so scanned guest data is never served stale from cache.
//
// This used to be cache-first (stale-while-revalidate): serve whatever's
// cached instantly, then silently refresh the cache in the background for
// NEXT time. That meant a device that had this page open once could keep
// replaying that exact stale copy indefinitely, only ever catching up one
// load behind — a real problem for a door-scanning page that gets fixed
// mid-event. Network-first means a phone with any connectivity always gets
// the current code; the cache is a true offline-only fallback now.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (!SHELL_FILES.some((f) => url.pathname.endsWith(f))) return;

  event.respondWith(
    (async () => {
      try {
        const response = await Promise.race([
          fetch(event.request),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
        ]);
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, response.clone());
        return response;
      } catch (e) {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        throw e;
      }
    })()
  );
});
