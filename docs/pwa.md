# PWA: install on phone

Ferd is meant to be installed on your phone as a standalone app with offline reads. The app shell, your data, and previously-viewed tiles work without network. Desktop install uses the same machinery but rarely earns its keep for a map app.

## What works offline

- App shell: HTML, CSS, JS, vendored Leaflet and plugins, PWA icons.
- Elevation chart and its deps (d3, togeojson, leaflet-geometryutil, leaflet-almostover, plus leaflet-elevation's own modular handlers and components). All vendored under `vendor/` and precached on install.
- Last loaded places, trails, GPX files, and category labels. `stale-while-revalidate` refreshes them in the background when you're back online. `/api/gpx/*.gpx` is cached the same way.
- Tiles you've previously viewed. Cap is ~50 MB with LRU eviction.
- Site config, manifest, and the full icon set.

## What needs network

- All edits and uploads. Mutating API calls return a clear "you're offline" error; on-disk data is untouched.
- Sign-in if your session has expired.
- Tiles for areas you haven't viewed before.

## Install on phone

Install only appears over HTTPS. `localhost` counts as secure for dev. For your phone you need a real HTTPS endpoint, see [Serving over HTTPS](#serving-over-https).

### Android (Vanadium, Chrome, Firefox-based)

1. Open Ferd.
2. Three-dot menu, then **Install app** (Chromium) or **Add to Home Screen**.
3. Confirm.

GrapheneOS / Vanadium: "Clear browsing data on exit" wipes the offline cache when you close the browser. Either disable it for Ferd's origin or accept that offline state rebuilds each session.

### iOS / iPadOS (Safari)

1. Open Ferd in Safari (not Chrome on iOS).
2. Share, then **Add to Home Screen**, then **Add**.

iOS purges PWA storage after a few weeks of disuse. Open the app once a week or so to keep the cache warm.

## Desktop install (optional)

Chrome, Edge, Brave, and other Chromium browsers show an install icon in the address bar. Firefox / LibreWolf don't expose desktop PWA install. Running as a tab is fine; the installed window is only useful if you want a dedicated taskbar entry.

## Updates

After a deploy, installed clients see an **Update available** toast on next visit. Tap **Reload** to swap to the new code.

`CACHE_VERSION` is derived from content. `sw.js` carries the literal placeholder `__FERD_CACHE_VERSION__`; `tools/api.py` substitutes it on every serve with `ferd-<hash>` covering `sw.js` plus every file in `SHELL_ASSETS`. Any shell change yields a fresh version, no manual bump.

The frontend calls `reg.update()` on every page load. Firefox is otherwise lazy about SW update checks and can leave users on an old shell for hours.

If a user doesn't see your latest change after a deploy:
- They haven't tapped Reload on the toast.
- They're on a stale background tab. Closing and reopening triggers an update check.

## Maintenance

### Vendored assets

Add a path to `SHELL_ASSETS` in `sw.js` for any new `vendor/` file the app needs at startup, otherwise it only works online. Drop the path and delete the file when removing. The content hash picks up both cases automatically; old shell caches get evicted on next activate.

### Tile cap

`TILE_MAX_ENTRIES = 2500` (~50 MB) and `TILE_TRIM_BATCH` in `sw.js` control the offline tile budget.

### Trail loading

Index map fetches GPX lazily: routes are pulled in only when their manifest `bbox` intersects the padded viewport AND would render at least 6px diagonally at the current zoom. The trail list view prefetches every GPX on render (4 at a time via the `fetchGpxText` limiter), so detail-view navigation hits the SW cache and the polyline renders with the first frame.

Loaded trails stay on the map until the page is left. No eviction. If memory ever bites at large trail counts, add an LRU drop on `state._trailLayers`.

## Serving over HTTPS

Required for install to appear on phones.

- **Tailscale Serve**: `tailscale serve --https=443 http://localhost:8090`. The `*.<tailnet>.ts.net` URL has a valid cert and is reachable from any tailnet device.
- **Caddy**: a few lines in a Caddyfile, automatic Let's Encrypt. Sample in `deploy/Caddyfile.example`.
- **Cloudflare Tunnel**: public URL without exposing a port. Free for personal use.

`localhost` works without HTTPS for local dev.

## Known limitations

- iOS PWAs may have their cache purged after a few weeks of disuse.
- iOS launch splash shows a generic background with the auto-rendered icon; a proper one needs `apple-touch-startup-image` PNG files per device size and orientation. Tracked on the roadmap.
