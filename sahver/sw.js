// ─────────────────────────────────────────────
//  SINGLE VERSION NUMBER — change only this
// ─────────────────────────────────────────────
const VERSION = '14';
const CACHE = `sahver-${VERSION}`;

// Helper to append ?v=VERSION to URLs
const v = url => `${url}?v=${VERSION}`;

// ─────────────────────────────────────────────
//  FILES TO PRE-CACHE (auto-versioned)
// ─────────────────────────────────────────────
const SHELL = [
  v('./index.html'),
  v('./offline.html'),
  v('./style.css'),
  v('./app.js'),
  v('./manifest.json'),

  v('./apple-touch-icon.png'),
  v('./favicon.ico'),
  v('./favicon-16x16.png'),
  v('./favicon-32x32.png'),
  v('./android-chrome-192x192.png'),
  v('./android-chrome-512x512.png'),
  v('./icon-16.png'),
  v('./icon-32.png'),
  v('./icon-180.png'),
  v('./icon-192.png'),
  v('./icon-512.png'),

  v('./fonts/DM_Sans/DMSans-VariableFont_opsz,wght.ttf'),
  v('./fonts/DM_Sans/DMSans-Italic-VariableFont_opsz,wght.ttf'),
  v('./fonts/Lora/Lora-VariableFont_wght.ttf'),
  v('./fonts/Lora/Lora-Italic-VariableFont_wght.ttf'),
];


// ─────────────────────────────────────────────
//  INSTALL — pre-cache shell + activate instantly
// ─────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(
      SHELL.map(url =>
        cache.add(url).catch(err =>
          console.warn('[SW] Failed to cache', url, err)
        )
      )
    );
    self.skipWaiting(); // activate immediately
  })());
});

// ─────────────────────────────────────────────
//  ACTIVATE — delete old caches + take control
// ─────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    );
    await self.clients.claim(); // control all pages immediately
  })());
});

// ─────────────────────────────────────────────
//  MESSAGE — allow app to force activation
// ─────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ─────────────────────────────────────────────
//  FETCH — stale-while-revalidate for everything
// ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (!url.protocol.startsWith('http')) return;

  event.respondWith(staleWhileRevalidate(event.request));
});

// ─────────────────────────────────────────────
//  STRATEGY: stale-while-revalidate
// ─────────────────────────────────────────────
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);

  const cached = await cache.match(request);

  const network = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || network || fallback(request);
}

// ─────────────────────────────────────────────
//  FALLBACKS
// ─────────────────────────────────────────────
async function fallback(request) {
  if (request.mode === 'navigate') {
    return caches.match('./offline.html');
  }
  return new Response('', { status: 503 });
}