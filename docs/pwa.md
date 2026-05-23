# PWA: install on phone or desktop

Ferd ships as an installable Progressive Web App. Once installed it runs from your home screen or app launcher like a native app, in its own window with no browser chrome, and keeps working offline for reads.

## What works offline

- The app shell (HTML, CSS, JS, vendored Leaflet and plugins).
- The last loaded copy of your places, trails, GPX files, and category labels (`stale-while-revalidate`, so they refresh in the background when you're back online).
- Map tiles you've previously viewed, across all configured providers, capped at roughly 50 MB with least-recently-used eviction.
- Site config and favicon.

## What needs network

- All edits and uploads (add/edit/delete places, upload GPX, change publish state, admin actions). Mutating API calls fail with a clear "you're offline" message; data on disk is untouched.
- The elevation chart: leaflet-elevation lazy-loads d3 and helper plugins from CDN the first time you open a chart. Tracked in the roadmap.
- Initial sign-in if your session has expired.

## Install

You need to access Ferd over HTTPS for the install option to appear in browsers. `localhost` is treated as secure by browsers, so local dev works without certificates. For phone install over your home or tailnet, see [Serving over HTTPS](#serving-over-https) below.

### Android (Vanadium, Chrome, Firefox-based)

1. Open Ferd in the browser.
2. Three-dot menu -> **Install app** (Chromium-based browsers) or **Add to Home Screen**.
3. Confirm. The icon appears in the launcher and opens in standalone mode.

GrapheneOS / Vanadium note: if "Clear browsing data on exit" is enabled, the offline cache gets wiped each time you close the browser. Either disable it for Ferd's origin or accept that offline state will rebuild on each session.

### iOS / iPadOS (Safari)

1. Open Ferd in Safari (must be Safari, not Chrome on iOS).
2. Share button -> **Add to Home Screen** -> **Add**.

iOS PWAs have stricter storage rules than Android: if you don't open the app for a few weeks, Safari may purge its cache. Reopening once a week or so keeps it warm.

### Desktop (Chrome, Edge, Brave, Vanadium, etc.)

1. Open Ferd in the browser.
2. Look for the install icon in the address bar (square with down-arrow) or three-dot menu -> **Install Ferd**.
3. Confirm. The PWA opens in its own window.

Firefox / LibreWolf do not support PWA install on desktop. The site still works as a regular tab.

## Updates

When you deploy a new version of Ferd, installed clients see an **Update available** toast near the bottom of the screen on next visit. Tap **Reload** to swap to the new code. The toast appears whenever `CACHE_VERSION` in `sw.js` differs from the version the client already has.

If a user reports they don't see your latest change after a deploy, it's almost always one of:
- They haven't tapped Reload on the update toast yet.
- They're on a stale background tab; closing and reopening triggers an update check.
- (Rare) The service worker file itself was served from a cache that shouldn't have one. The static handler in `tools/api.py` sends `Cache-Control: no-cache` on every file, which avoids this.

## Maintenance

### Bump `CACHE_VERSION` on user-visible releases

Open `sw.js` and increment the `CACHE_VERSION` string (e.g. `ferd-v28` -> `ferd-v29`). This is what causes the "Update available" toast to appear for existing installs. Without the bump, the service worker treats your new HTML/JS as the same release and clients may keep running the old cached shell longer than you'd like.

If you forget, the network-first strategy on `/index.html` will still update most users on next reload; bumping just makes the prompt explicit and reliable.

### Adding a new vendored asset

If you add a file under `vendor/` that the app needs to load at start, add the path to the `SHELL_ASSETS` list in `sw.js`. Otherwise the file is only available when online and the install will not be self-sufficient.

### Removing a vendored asset

Drop it from `SHELL_ASSETS` and delete the file. Bump `CACHE_VERSION` so old shell caches (which precached the now-missing path) get cleared.

### Tile cap

Default tile cache is `TILE_MAX_ENTRIES = 2500` entries (~50 MB at typical tile sizes). Adjust both that constant and `TILE_TRIM_BATCH` in `sw.js` if you want a larger or smaller offline tile budget.

## Serving over HTTPS

Required for the install option to appear on phones. A few common paths:

- **Tailscale Serve**: zero-config HTTPS via `*.<tailnet>.ts.net`. Run `tailscale serve --https=443 http://localhost:8090` on the host. The tailnet-only URL has a valid certificate from Tailscale's CA and is reachable by any device on your tailnet.
- **Caddy**: drop a few lines in a Caddyfile, automatic Let's Encrypt. Sample in `deploy/Caddyfile.example`.
- **Cloudflare Tunnel**: if you want a public URL without exposing a port. Free for personal use.

`localhost` works without any of this for local dev.

## Known limitations

- iOS PWAs may have their cache purged after a few weeks of disuse.
- The elevation chart depends on a runtime CDN fetch and won't work offline until those deps are vendored too.
- Firefox-based browsers on desktop don't expose PWA install. The site still works as a tab.
- `CACHE_VERSION` bumps are manual today; automating it is on the roadmap.
