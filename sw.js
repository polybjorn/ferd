// Ferd service worker.
// CACHE_VERSION is rewritten on serve by tools/api.py: the placeholder
// below gets replaced with `ferd-<hash>` where the hash covers sw.js
// itself plus every file in SHELL_ASSETS. Any shell change yields a new
// version automatically; do not edit the literal by hand.
const CACHE_VERSION = '__FERD_CACHE_VERSION__';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const TILE_CACHE = `${CACHE_VERSION}-tiles`;

// Tile cap: ~2500 entries (~50 MB at ~20 KB/tile).
const TILE_MAX_ENTRIES = 2500;
const TILE_TRIM_BATCH = 250;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/ui.css',
  '/ui.js',
  '/app/add/add.js',
  '/app/add/browse.js',
  '/app/app.css',
  '/app/area-geo.js',
  '/app/areas/add-area.js',
  '/app/areas/area-payload.js',
  '/app/areas/areas-page.js',
  '/app/areas/edit-area.js',
  '/app/auth.js',
  '/app/backup.js',
  '/app/bottom-bar.js',
  '/app/context-menu.js',
  '/app/core.js',
  '/app/countries.js',
  '/app/form-fields.js',
  '/app/gpx-text.js',
  '/app/history.js',
  '/app/i18n.js',
  '/app/main.js',
  '/app/map/area-layer.js',
  '/app/map/country-layer.js',
  '/app/map/home-map.js',
  '/app/map/index.js',
  '/app/map/map-actions.js',
  '/app/map/map-layers.js',
  '/app/map/map-markers.js',
  '/app/map/map-panel.js',
  '/app/map/map-phone.js',
  '/app/map/map-popups.js',
  '/app/map/map-wheel.js',
  '/app/map/pick-coords.js',
  '/app/map/place-layer.js',
  '/app/map/popups.js',
  '/app/map/route-detail.js',
  '/app/map/route-layer.js',
  '/app/map/search-keys.js',
  '/app/map/sync.js',
  '/app/modal.js',
  '/app/places-list.js',
  '/app/places/places-page.js',
  '/app/list-controls.js',
  '/app/places/add-place.js',
  '/app/places/edit-place.js',
  '/app/places/place-payload.js',
  '/app/prefs.js',
  '/app/router.js',
  '/app/routes/routes-page.js',
  '/app/routes/add-route.js',
  '/app/routes/route-meta.js',
  '/app/routes/route-payload.js',
  '/app/select.js',
  '/app/server.js',
  '/app/settings/account.js',
  '/app/settings/catalog.js',
  '/app/settings/categories.js',
  '/app/settings/logs.js',
  '/app/settings/regions.js',
  '/app/settings/settings.js',
  '/app/sign-in.js',
  '/app/store.js',
  '/app/tags.js',
  '/app/theme.js',
  '/app/view.js',
  '/app/you.js',
  '/catalog.json',
  '/vendor/natural-earth/country-list.json',
  '/vendor/natural-earth/country-names.json',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable.png',
  '/icons/apple-touch-icon.png',
  '/icons/manifest.webmanifest',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/images/marker-icon.png',
  '/vendor/leaflet/images/marker-icon-2x.png',
  '/vendor/leaflet/images/marker-shadow.png',
  '/vendor/leaflet/images/layers.png',
  '/vendor/leaflet/images/layers-2x.png',
  '/vendor/leaflet-tilelayer-nogap/L.TileLayer.NoGap.js',
  '/vendor/supercluster/supercluster.min.js',
  '/vendor/leaflet-gpx/gpx.js',
  '/vendor/preact/preact.js',
  '/vendor/preact/hooks.js',
  '/vendor/htm/htm.js',
  '/vendor/signals/signals.js',
  '/vendor/signals/signals-core.js',
  '/vendor/leaflet-elevation/leaflet-elevation.css',
  '/vendor/leaflet-elevation/leaflet-elevation.js',
  '/vendor/src/components/chart.js',
  '/vendor/src/components/marker.js',
  '/vendor/src/components/summary.js',
  '/vendor/src/handlers/acceleration.js',
  '/vendor/src/handlers/altitude.js',
  '/vendor/src/handlers/cadence.js',
  '/vendor/src/handlers/distance.js',
  '/vendor/src/handlers/heart.js',
  '/vendor/src/handlers/labels.js',
  '/vendor/src/handlers/lineargradient.js',
  '/vendor/src/handlers/pace.js',
  '/vendor/src/handlers/runner.js',
  '/vendor/src/handlers/slope.js',
  '/vendor/src/handlers/speed.js',
  '/vendor/src/handlers/temperature.js',
  '/vendor/src/handlers/time.js',
  '/vendor/libs/leaflet-distance-marker.min.js',
  '/vendor/libs/leaflet-edgescale.min.js',
  '/vendor/libs/leaflet-hotline.min.js',
  '/vendor/images/elevation.svg',
];

// Base map hosts whose terms allow keeping tiles offline. OpenStreetMap's
// tile policy forbids offline use, so its tiles (OpenStreetMap and Dark) are
// left to the browser's HTTP cache, which honours the server's headers.
const TILE_HOSTS = [
  'tile.opentopomap.org',
  'a.tile.opentopomap.org',
  'b.tile.opentopomap.org',
  'c.tile.opentopomap.org',
];

// OVERLAY-HOSTS-BEGIN (tests/js/overlays.test.js runs this block)
// Hosts of the overlays in site-config.json that set `offline: true`, so
// their tiles cache offline like OpenTopoMap's do. The rest are left to the
// browser's HTTP cache, since not every provider's terms allow keeping tiles.
// Caching is per host, so one opted-in entry covers every overlay on it.
// {s} expands to each subdomain, Leaflet's default being abc; any other
// {placeholder} cannot sit in a hostname.
function overlayHosts(cfg) {
  const hosts = new Set();
  const list = cfg && Array.isArray(cfg.overlays) ? cfg.overlays : [];
  for (const o of list) {
    if (!o || o.offline !== true || typeof o.url !== 'string') continue;
    const subs = typeof o.subdomains === 'string' && o.subdomains ? o.subdomains : 'abc';
    const urls = o.url.includes('{s}') ? Array.from(subs, (c) => o.url.split('{s}').join(c)) : [o.url];
    for (const u of urls) {
      let parsed;
      try { parsed = new URL(u.replace(/\{[^}]*\}/g, '0')); } catch (e) { continue; }
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') hosts.add(parsed.hostname);
    }
  }
  return Array.from(hosts);
}
// OVERLAY-HOSTS-END

// Read once per worker start, from the copy the page already cached when it
// can be. A tile requested before this settles is fetched uncached.
let overlayHostSet = new Set();
(async () => {
  try {
    const url = new URL('site-config.json', self.registration.scope).href;
    const res = (await caches.match(url)) || (await fetch(url));
    if (res && res.ok) overlayHostSet = new Set(overlayHosts(await res.json()));
  } catch (e) {}
})();

self.addEventListener('install', (event) => {
  event.waitUntil(
    // A plain fetch here could store a file the HTTP cache kept from an older
    // version, and the offline shell would then mismatch its page.
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_ASSETS.map((asset) => new Request(asset, { cache: 'reload' }))))
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
    if (TILE_HOSTS.includes(url.hostname) || overlayHostSet.has(url.hostname)) {
      event.respondWith(tileCacheFirst(req));
    }
    return;
  }

  // Same-origin routing.
  if (url.pathname.startsWith('/api/')) {
    // GPX downloads are large, immutable per filename, and the manifest is
    // the source of truth for which file is current; cache them so route
    // detail navigation doesn't pay a network round-trip every time.
    if (url.pathname.startsWith('/api/gpx/') && url.pathname.endsWith('.gpx')) {
      event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    }
    // Everything else under /api/ is network-only (auth, mutations, JSON).
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  if (url.pathname === '/ui.css' || url.pathname === '/ui.js' || url.pathname.startsWith('/app/')) {
    event.respondWith(networkThenShell(req));
    return;
  }

  if (
    url.pathname.startsWith('/vendor/') ||
    url.pathname.startsWith('/icons/')
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

// The link's version query is not part of the precached key.
async function networkThenShell(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
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
