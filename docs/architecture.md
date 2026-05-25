# Architecture

A one-page tour of what the app is made of and how the pieces fit. If you just want to deploy it, see [python.md](python.md) or [docker.md](docker.md); if you want to change it, start here.

## Pieces

Two things glued together at one HTTP origin:

1. **A single-file SPA frontend.** `index.html` is the whole app: HTML, CSS, and vanilla JavaScript in one file. It loads Leaflet from a CDN and fetches everything else (`site-config.json`, places, routes, GPX) from the API. No build step, no framework, no bundler.
2. **The Python API.** `tools/api.py` is a stdlib-only HTTP server (`http.server` + `sqlite3`) that handles auth, per-user reads and writes, and serves the static files so the app runs from one origin.

The frontend talks to the API via `fetch`; the API stores users, sessions, and per-user publish state in SQLite and writes each user's places/trails to JSON and GPX files under their own folder on disk.

## Data on disk

Two stores: SQLite for auth and runtime state (`tools/app.db`: users + `published` flag, sessions, audit log capped at 5000 rows, site settings; login rate-limit counters are in-memory), and JSON/GPX files on disk for content (per-user under `users/<username>/`, site-wide config at the data-dir root). The split is deliberate: content stays human-editable and version-controllable; auth stays in a real database with constraints and locking. Per-user folders make export trivial (zip the folder).

See [configure.md](configure.md#data-files) for the full file-by-file table.

## Request flow

- **Owner view (signed in at `/`).** Browser fetches `index.html`, `site-config.json` (static), then `/api/state`, `/api/places`, `/api/routes`. Edits go through `POST/PUT/DELETE /api/places` and `/api/gpx`; each write validates the input, takes a file lock under the user's folder, writes atomically (temp file then rename), and re-runs the manifest script for that user when GPX changes.
- **Public view (`/u/<username>/`).** The static handler rewrites the path to `index.html`. The SPA detects the URL prefix and fetches `/api/u/<username>/{places,routes,metadata,gpx/...}` instead. The server returns 404 on any of those unless the named user has `published=1`. No write endpoints are reachable through the public path.
- **Auth.** Cookie-based sessions (`HttpOnly`, `SameSite=Lax`). PBKDF2-SHA256 password hashing. Per-IP rate limit on login. First user to register becomes admin; further registrations require the admin to flip the site-wide registration toggle. See [SECURITY.md](../SECURITY.md) for the full account model.

## Repository layout

Entries within each directory are sorted alphabetically (case-insensitive).

```
.dockerignore              # files excluded from image build context
.env.example               # Docker env-var template
catalog.json               # shipped baseline site catalog
CHANGELOG.md               # release notes
compose.yml                # Docker Compose service definition
CONTRIBUTING.md            # how to run, test, and submit changes
deploy/
  Caddyfile.example        # Caddy server block
  docker-entrypoint.sh     # Docker entrypoint (UID/GID handling)
  ferd-api.plist           # macOS launchd template
  ferd-api.service         # systemd service unit
  ferd-api.socket          # systemd socket unit
  install.sh               # guided installer
  nginx.example.conf       # nginx server block
  uninstall.sh             # guided uninstaller
docs/
  api.md                   # /api/* endpoint reference + smoke recipes
  architecture.md          # this file
  catalog.md               # site catalog (shipped baseline + local additions)
  configure.md             # config field reference
  docker.md                # running with Docker
  pwa.md                   # PWA install + service-worker maintenance
  python.md                # running with Python
  screenshots/             # images for README and docs
  themes.md                # theme system + how to add one
Dockerfile                 # container image
icons/                     # favicon, PWA icons, web app manifest
index.html                 # the app (HTML/CSS/JS in one file)
LICENSE
README.md
scripts/
  check-vendor-versions.py # weekly CI drift check against npm
  gpx-manifest.sh          # generates routes.json from gpx/<Region>/<Trail>.gpx
  vendor-versions.json     # tracked versions per vendored dep
SECURITY.md                # account model, setup token, threat notes
site-config.example.json   # branding, default view, category labels, API base
sw.js                      # PWA service worker (cache shell, tiles, GPX)
tests/
  test_api_helpers.py      # unit tests for pure helpers
  test_api_integration.py  # subprocess + HTTP integration tests
  test_shipped_catalog.py  # CI-enforced catalog conventions
tools/
  api.py                   # stdlib-only API server (auth + write endpoints)
  config.example.json      # API config template
vendor/                    # vendored third-party libs (see vendor/NOTICES.md)
VERSION                    # app version (surfaced in /api/state)
```

## Why no build step

Two-person threshold: the project is small enough that a build step would cost more than it buys. As long as that holds, the rule is:

- Vanilla JS for the frontend.
- Stdlib only for the API. No `pip install` to run the server.
- No dependency for something that fits in fifty lines.

If you're proposing a change that breaks one of these, lead the PR with the why.

## Platform targets

Minimums for any change to the frontend. Don't drop below them without a real reason.

- **Browsers:** Baseline Widely Available (caniuse.com / web-platform-dx).
- **Viewport:** desktop first (>=1024 px). Mobile portrait works down to 320 px. Installable as a PWA (own home-screen icon, standalone window), no native wrapper.
- **CSS:** baseline only. In: `:has()`, `:is()`, `:where()`, grid, flex, custom properties, logical properties, `aspect-ratio`, `prefers-*`. Wait for baseline: container queries, subgrid, `color-mix()`, anchor positioning.
- **Accessibility:** required. Semantic HTML, labels on every input, Esc closes modals, `prefers-reduced-motion` is respected, WCAG AA contrast on every theme.
- **Network:** edits require network and fail loudly when offline. Reads are offline-capable through a hand-rolled service worker (`sw.js`) that precaches the app shell and vendored deps, runs `stale-while-revalidate` on JSON data, and cache-firsts map tiles with an LRU cap. See [pwa.md](pwa.md).
- **Performance:** soft target under 1s first paint on a 5-year-old laptop, under 500 KB of JS+CSS+HTML on first load (tiles and GPX excluded).
- **i18n:** English UI today. Keep the language `<select>` in place so localization can be added later. Data round-trips arbitrary Unicode.
- **Privacy:** no third-party at runtime except map tile providers. No analytics, no third-party fonts, no external APIs from the page.

## Code style

- 2-space indentation, JavaScript and Python alike.
- Comments only where the why is non-obvious. Don't document what the next line literally does.
- Match the existing nesting and naming. The frontend uses lowercase camelCase functions; the API uses `_h_` prefixed handler methods and snake_case helpers.
