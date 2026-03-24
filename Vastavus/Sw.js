const CACHE = 'mesilased-v4';

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './favicon-16.png',
  './favicon-32.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  // Add your images here — they must be listed to work offline:
  './pildid/apple.jpg',
  './pildid/banana.png',
  './pildid/carrot.jpg',
  './pildid/potato.jpg',
  './pildid/tomato.jpg',
  './pildid/watermelon.jpg',
  './pildid/cherries.jpg'
];

// Install: cache everything
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first, fall back to network
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});