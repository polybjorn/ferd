// Ferd service worker.
// Bump CACHE_VERSION on each release that changes the app shell or vendor deps.
const CACHE_VERSION = 'ferd-v29';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const TILE_CACHE = `${CACHE_VERSION}-tiles`;

// Tile cap: ~2500 entries (~50 MB at ~20 KB/tile).
const TILE_MAX_ENTRIES = 2500;
const TILE_TRIM_BATCH = 250;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/images/marker-icon.png',
  '/vendor/leaflet/images/marker-icon-2x.png',
  '/vendor/leaflet/images/marker-shadow.png',
  '/vendor/leaflet/images/layers.png',
  '/vendor/leaflet/images/layers-2x.png',
  '/vendor/leaflet-tilelayer-nogap/L.TileLayer.NoGap.js',
  '/vendor/supercluster/supercluster.min.js',
  '/vendor/leaflet-gpx/gpx.min.js',
  '/vendor/leaflet-elevation/leaflet-elevation.css',
  '/vendor/leaflet-elevation/leaflet-elevation.js',
];

const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
  'tile.opentopomap.org',
  'a.tile.opentopomap.org',
  'b.tile.opentopomap.org',
  'c.tile.opentopomap.org',
  'tile-cyclosm.openstreetmap.fr',
  'a.tile-cyclosm.openstreetmap.fr',
  'b.tile-cyclosm.openstreetmap.fr',
  'c.tile-cyclosm.openstreetmap.fr',
  'server.arcgisonline.com',
  'basemaps.cartocdn.com',
  'a.basemaps.cartocdn.com',
  'b.basemaps.cartocdn.com',
  'c.basemaps.cartocdn.com',
  'd.basemaps.cartocdn.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => !n.startsWith(CACHE_VERSION))
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin: tiles get cached, everything else passes through.
  if (url.origin !== self.location.origin) {
    if (TILE_HOSTS.includes(url.hostname)) {
      event.respondWith(tileCacheFirst(req));
    }
    return;
  }

  // Same-origin routing.
  if (url.pathname.startsWith('/api/')) {
    return; // network-only
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  if (
    url.pathname.startsWith('/vendor/') ||
    url.pathname === '/favicon.svg' ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  if (
    url.pathname.endsWith('.json') ||
    url.pathname.endsWith('.gpx') ||
    url.pathname.includes('/gpx/')
  ) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }
  // Default: network-only.
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return cached || Response.error();
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req) || await cache.match('/index.html') || await cache.match('/');
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

let tilePutCount = 0;
async function tileCacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      cache.put(req, res.clone()).then(() => {
        // Only sweep occasionally so the keys() scan doesn't run on every
        // tile fetch during pinch-zoom.
        if ((++tilePutCount % 100) === 0) trimTileCache();
      });
    }
    return res;
  } catch (err) {
    return cached || Response.error();
  }
}

async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length <= TILE_MAX_ENTRIES) return;
  const toDelete = keys.slice(0, keys.length - TILE_MAX_ENTRIES + TILE_TRIM_BATCH);
  await Promise.all(toDelete.map((k) => cache.delete(k)));
}
