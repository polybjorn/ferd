# PWA: install on phone

Ferd is built primarily for **installing on your phone** as a standalone app, with offline reads. Once installed it runs from the home screen with no browser chrome, and the app shell, your data, and tiles you've already viewed work without network. Desktop install is supported by the same machinery but is rarely worth it for a map app.

## What works offline

- The app shell (HTML, CSS, JS, vendored Leaflet and plugins, PWA icons).
- The elevation chart and all its dependencies (d3, togeojson, leaflet-geometryutil, leaflet-almostover, leaflet-elevation's modular handlers and components) are vendored under `vendor/` and precached on install — opens a chart without any network access.
- The last loaded copy of your places, trails, GPX files, and category labels (`stale-while-revalidate`, so they refresh in the background when you're back online). GPX downloads from `/api/gpx/*.gpx` are cached the same way.
- Map tiles you've previously viewed, across all configured providers, capped at roughly 50 MB with least-recently-used eviction.
- Site config, manifest, and the full icon set (PNG and SVG).

## What needs network

- All edits and uploads (add/edit/delete places, upload GPX, change publish state, admin actions). Mutating API calls fail with a clear "you're offline" message; data on disk is untouched.
- Initial sign-in if your session has expired.
- Map tiles for areas you haven't viewed before.

## Install on phone

The install option only appears when Ferd is served over HTTPS. `localhost` counts as secure, so dev on the host works. For your phone you'll need an HTTPS endpoint — see [Serving over HTTPS](#serving-over-https) below.

### Android (Vanadium, Chrome, Firefox-based)

1. Open Ferd in the browser.
2. Three-dot menu -> **Install app** (Chromium-based) or **Add to Home Screen**.
3. Confirm. The icon appears in the launcher and opens in standalone mode.

GrapheneOS / Vanadium note: if "Clear browsing data on exit" is enabled, the offline cache gets wiped each time you close the browser. Either disable it for Ferd's origin or accept that offline state will rebuild on each session.

### iOS / iPadOS (Safari)

1. Open Ferd in Safari (must be Safari, not Chrome on iOS).
2. Share button -> **Add to Home Screen** -> **Add**.

iOS PWAs have stricter storage rules than Android: if you don't open the app for a few weeks, Safari may purge its cache. Reopening once a week or so keeps it warm.

## Desktop install (optional)

The same manifest + service worker lets you install Ferd as a standalone desktop window in Chrome, Edge, Brave, and other Chromium-based browsers — look for the install icon in the address bar. Firefox / LibreWolf don't expose desktop PWA install at all; the site still works fine as a tab. There's no real reason to prefer the installed version over a tab on desktop unless you use Ferd daily and like a dedicated window.

## Updates

When you deploy a new version of Ferd, installed clients see an **Update available** toast near the bottom of the screen on next visit. Tap **Reload** to swap to the new code.

`CACHE_VERSION` is derived automatically — `sw.js` carries the literal placeholder `__FERD_CACHE_VERSION__`, and `tools/api.py` substitutes it on every serve with `ferd-<hash>` where the hash covers `sw.js` itself plus every file listed in its `SHELL_ASSETS` array. Any shell change (frontend, vendor, manifest, icons) yields a fresh version with no manual bump.

The frontend calls `reg.update()` on every page load to force the browser to check for a new SW immediately. Firefox especially is otherwise lazy about update checks and would leave users on an old shell for hours.

If a user reports they don't see your latest change after a deploy, it's almost always one of:
- They haven't tapped Reload on the update toast yet.
- They're on a stale background tab; closing and reopening triggers an update check.

## Maintenance

### Adding a new vendored asset

If you add a file under `vendor/` that the app needs to load at start, add the path to the `SHELL_ASSETS` list in `sw.js`. Otherwise the file is only available when online and the install will not be self-sufficient. The content hash automatically picks up the addition; no version bump needed.

### Removing a vendored asset

Drop it from `SHELL_ASSETS` and delete the file. The content hash picks up the change automatically; old shell caches get evicted on next activate.

### Tile cap

Default tile cache is `TILE_MAX_ENTRIES = 2500` entries (~50 MB at typical tile sizes). Adjust both that constant and `TILE_TRIM_BATCH` in `sw.js` if you want a larger or smaller offline tile budget.

### Trail loading strategy

The index map fetches GPX files lazily: only routes whose bbox intersects the current viewport (padded by 50%) AND would render at least 6px diagonally at the current zoom get fetched. The trail list view prefetches every GPX on render (4-at-a-time via the concurrency limiter in `index.html`) so subsequent navigations into a trail detail hit the SW runtime cache and render the polyline immediately.

Loaded trails stay in memory and on the map until the page is left, even if you pan away from their bbox. No eviction yet; if memory becomes an issue at large trail counts, add an LRU drop on `state._trailLayers`.

## Serving over HTTPS

Required for the install option to appear on phones. A few common paths:

- **Tailscale Serve**: zero-config HTTPS via `*.<tailnet>.ts.net`. Run `tailscale serve --https=443 http://localhost:8090` on the host. The tailnet-only URL has a valid certificate from Tailscale's CA and is reachable by any device on your tailnet.
- **Caddy**: drop a few lines in a Caddyfile, automatic Let's Encrypt. Sample in `deploy/Caddyfile.example`.
- **Cloudflare Tunnel**: if you want a public URL without exposing a port. Free for personal use.

`localhost` works without any of this for local dev.

## Known limitations

- iOS PWAs may have their cache purged after a few weeks of disuse.
- The custom iOS launch splash needs `apple-touch-startup-image` PNG files per device size and orientation; without them iOS shows a generic splash with the auto-rendered icon. Tracked on the roadmap.
