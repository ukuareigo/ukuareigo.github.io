// ── Cache version ─────────────────────────────────────────────
// Bump this string on every deploy to bust the old cache.
const CACHE = 'sahver-13';

// App shell files to pre-cache on install.
// IMPORTANT: every file listed here must exist on the server.
// A single 404 used to abort the entire install — now handled gracefully.
const SHELL = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './offline.html',
  './apple-touch-icon.png',
  './favicon.ico',
  './favicon-16x16.png',
  './favicon-32x32.png',
  './android-chrome-192x192.png',
  './android-chrome-512x512.png',
  './icon-16.png',
  './icon-32.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',

  // Self-hosted fonts
  './fonts/DM_Sans/DMSans-VariableFont_opsz,wght.ttf',
  './fonts/DM_Sans/DMSans-Italic-VariableFont_opsz,wght.ttf',
  './fonts/Lora/Lora-VariableFont_wght.ttf',
  './fonts/Lora/Lora-Italic-VariableFont_wght.ttf',
];

// ── Install: pre-cache the app shell ─────────────────────────
// Each file is cached individually so a single failure (e.g. a missing
// icon) does not abort the entire install and leave the app uncached.
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(
      SHELL.map(url =>
        cache.add(url).catch(err =>
          console.warn(`[SW] Failed to cache ${url}:`, err)
        )
      )
    );
    await self.skipWaiting();
  })());
});

// ── Activate: delete any old cache versions ───────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Ignore non-http schemes (chrome-extension://, data:, blob: etc.)
  if (!url.protocol.startsWith('http')) return;

  const isFont = url.hostname.includes('googleapis') ||
                 url.hostname.includes('gstatic');

  if (isFont) {
    e.respondWith(networkFirstFont(e.request));
  } else {
    e.respondWith(cacheFirst(e.request));
  }
});

// ── Network-first (Google Fonts) ─────────────────────────────
async function networkFirstFont(request) {
  try {
    const response = await fetch(request);
    const cache    = await caches.open(CACHE);
    cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('', { status: 503, statusText: 'Service Unavailable' });
  }
}

// ── Cache-first (app shell + assets) ─────────────────────────
async function cacheFirst(request) {
  // ── Navigation fallback ───────────────────────────────────
  // The browser navigates to '/' but the cache stores './index.html'
  // under its full URL. If there's no exact match for the navigation
  // request, fall back to the cached index.html explicitly.
  const isNavigation = request.mode === 'navigate';

  const cached = await caches.match(request) ||
    (isNavigation ? await caches.match('./index.html') : null);

  // Background refresh — keeps the cache up to date for next visit
  const networkPromise = fetch(request)
    .then(async response => {
      if (response.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // Serve cache immediately if available
  if (cached) return cached;

  // No cache — wait for network
  const networkResponse = await networkPromise;
  if (networkResponse) return networkResponse;

  // Both failed — serve offline page for navigation, 503 for assets
  if (isNavigation) {
    const offline = await caches.match('./offline.html');
    if (offline) return offline;
  }

  return new Response('', { status: 503, statusText: 'Service Unavailable' });
}