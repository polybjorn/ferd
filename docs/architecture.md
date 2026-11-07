# Architecture

A one-page tour of what the app is made of and how the pieces fit. If you just want to deploy it, see [python.md](python.md) or [docker.md](docker.md); if you want to change it, start here.

## Pieces

Two things glued together at one HTTP origin:

1. **A static SPA frontend.** `index.html` holds the markup and `app/` the stylesheet and vanilla JavaScript, as native ES modules the browser loads directly, with `app/main.js` as the entry. Leaflet and its plugins are vendored under `vendor/` and served from the same origin, so the only external host at runtime is the map tile provider. Everything else (`site-config.json`, places, routes, GPX) comes from the API. Dialogs converted to components use Preact with htm templates, vendored and mapped by an import map in `index.html`, so there is still no build step and no bundler.
2. **The Python API.** `tools/api.py` is a stdlib-only HTTP server (`http.server` + `sqlite3`) that handles auth, per-user reads and writes, and serves the static files so the app runs from one origin.

The frontend talks to the API via `fetch`; the API stores users, sessions, and per-user publish state in SQLite and writes each user's places/routes to JSON and GPX files under their own folder on disk.

## Data on disk

Two stores: SQLite for auth and runtime state (`tools/app.db`: users + `published` flag, sessions, audit log capped at 5000 rows, site settings; login rate-limit counters are in-memory), and JSON/GPX files on disk for content (per-user under `users/<username>/`, site-wide config at the data-dir root). The split is deliberate: content stays human-editable and version-controllable; auth stays in a real database with constraints and locking. Per-user folders make export trivial (zip the folder).

See [configure.md](configure.md#data-files) for the full file-by-file table.

## Request flow

- **Owner view (signed in at `/`).** Browser fetches `index.html`, `site-config.json` (static), then `/api/state`, `/api/places`, `/api/routes`. Edits go through `POST/PUT/DELETE /api/places` and `/api/gpx`; each write validates the input, takes a file lock under the user's folder, writes atomically (temp file then rename), and re-runs the manifest script for that user when GPX changes.
- **Public view (`/u/<username>/`).** The static handler rewrites the path to `index.html`. The SPA detects the URL prefix and fetches `/api/u/<username>/{places,routes,metadata,gpx/...}` instead. The server returns 404 on any of those unless the named user has `published=1`. No write endpoints are reachable through the public path.
- **Auth.** Cookie-based sessions (`HttpOnly`, `SameSite=Lax`) for browsers, or bearer API tokens (`Authorization: Bearer`) for non-browser clients. Session and token values are stored SHA-256-hashed. PBKDF2-SHA256 password hashing. Per-IP rate limit on login. First user to register becomes admin; further registrations require the admin to flip the site-wide registration toggle. See [SECURITY.md](../SECURITY.md) for the full account model.

## Repository layout

Three groups: directories, repo-meta files, then the rest. Alphabetical (case-insensitive) within each.

```
.github/
  ISSUE_TEMPLATE/          # bug report + feature request forms
  workflows/               # tests, CodeQL, Docker publish, APK release, vendor drift
  pull_request_template.md
android/                   # Android client: WebView wrapper around the frontend
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
  screenshots/             # images for README and docs
  README.md                # index of this folder
  api.md                   # /api/* endpoint reference + smoke recipes
  architecture.md          # this file
  catalog.md               # site catalog (shipped baseline + local additions)
  configure.md             # config field reference
  docker.md                # running with Docker
  pwa.md                   # PWA install + service-worker maintenance
  python.md                # running with Python
  themes.md                # theme system + how to add one
  troubleshooting.md       # console messages you can safely ignore
icons/                     # favicon, PWA icons, web app manifest
scripts/
  build-countries.py       # builds vendor/natural-earth/ from Natural Earth
  check-refactor.sh        # jscpd + radon pass, run weekly in CI
  gpx-manifest.sh          # generates routes.json from gpx/<Region>/<Route>.gpx
  vendor-versions.json     # pinned versions, read by Renovate and check-refactor.sh
tests/
  test_api_helpers.py      # unit tests for pure helpers
  test_api_integration.py  # subprocess + HTTP integration tests
  test_shipped_catalog.py  # CI-enforced catalog conventions
  test_ui_css.py           # how ui.css loads and the cascade layer order
tools/
  api.py                   # stdlib-only API server (auth + write endpoints)
  config.example.json      # API config template
vendor/                    # vendored third-party libs (see vendor/NOTICES.md)

CHANGELOG.md               # release notes
CODE_OF_CONDUCT.md         # contributor conduct policy
CONTRIBUTING.md            # how to run, test, and submit changes
LICENSE
README.md
SECURITY.md                # account model, setup token, threat notes
VERSION                    # app version (surfaced in /api/state)

app/                       # the frontend: app.css and ES modules, entered at main.js
.dockerignore              # files excluded from image build context
.env.example               # Docker env-var template
catalog.json               # shipped baseline site catalog
compose.yml                # Docker Compose service definition
Dockerfile                 # container image
index.html                 # the page: markup and script tags
site-config.example.json   # branding, feature flags, default view, API base
sw.js                      # PWA service worker (cache shell, tiles, GPX)
ui.css                     # shared form and modal building blocks, copied from bjorn/ui-foundation
```

## Why no build step

Two-person threshold: the project is small enough that a build step would cost more than it buys. As long as that holds, the rule is:

- Plain JS for the frontend, with Preact and htm for views (see below). The map stays plain Leaflet.
- Stdlib only for the API. No `pip install` to run the server.
- No dependency for something that fits in fifty lines.

If you're proposing a change that breaks one of these, lead the PR with the why.

## Views

Settings, Account and Admin run on Preact components written as htm tagged templates, which the browser loads as plain ES modules. The pilot weighed this against Vite with TypeScript and Svelte or Preact; the no-build option covered everything Settings needed, so the toolchain stays out.

- Text is escaped by default, so a component has no `escapeHtml` and no `innerHTML`.
- Each checkbox, radio and text field keeps its own state, because Preact compares `checked` and `value` with the live element on every render. A save that fails puts the control back through that state.
- `openViewModal(view, opts)` in `app/view.js` renders a component into a dialog and unmounts it on close. The view renders its own `.ui-dialog-head` and `.ui-dialog-body`. `app/view.js` also holds the shared pieces: field, toggle, radio pills, error box, copy button and `useFetch`.
- Selects stay uncontrolled (`selected` on the initial option), since `enhanceSelectsIn` drives the native element.
- The import map sits above the module preloads in `index.html`, because Firefox ignores one that comes after a preload has started.
- Leaflet popups and the map code stay plain strings and DOM, since Leaflet takes those directly.

The remaining screens are worth converting, in this order:

1. The dialogs Settings opens: catalog, categories, regions and logs. They finish the Settings area and reuse its pieces.
2. The edit forms: place, area and route metadata, with the shared fields in `form-fields.js`. Forms carry most of the escaping and the control state.
3. The Add dialog (`add.js`), the largest, once the form pieces from step 2 exist.
4. Lists and panels (places, routes, history, route detail), when a change touches them anyway. They mostly render read-only rows.

## Platform targets

Minimums for any change to the frontend. Don't drop below them without a real reason.

- **Browsers:** Baseline Widely Available (caniuse.com / web-platform-dx), with Chrome 99 as the WebView floor. The map layout already needs Chrome 105 for `:has()`. Below 99 the page shows an update-your-WebView notice instead of the app, since a browser without cascade layers drops every layered rule.
- **Viewport:** desktop first (>=1024 px). Mobile portrait works down to 320 px. Installable as a PWA (own home-screen icon, standalone window), no native wrapper.
- **CSS:** baseline only. In: `:has()`, `:is()`, `:where()`, grid, flex, custom properties, logical properties, `aspect-ratio`, `prefers-*`, cascade layers, container queries, `color-mix()`. Wait for baseline: subgrid, anchor positioning.
- **CSS layers:** `app/app.css` declares `@layer ui-tokens, reset, vendor, app, ui;`. The element resets sit in `reset`, below vendor CSS so they leave Leaflet's margins and link colours alone. Vendor CSS is imported into `vendor`, the app's own rules sit in `app`, and the building blocks in `ui.css` (field, toggle row, choice list, section, hint) sit in `ui`, so a general rule cannot beat a component. Keep new rules in a layer: unlayered CSS and `style=` attributes beat every layer. `ui.css` documents its markup contract at the top. It is a copy from a `bjorn/ui-foundation` tag, and its first line records the version: a change or a new block lands in that repo, gets a tag and is copied here unchanged, never edited in place.
- **Scales:** sizes come from the `ui.css` tokens: `--ui-text-*`, `--ui-space-*`, `--ui-radius-*`, `--ui-duration-*` and `--ui-z-*`. Text never goes below 0.75rem, which `tests/test_ui_css.py` holds. A literal is for what the scale can't say, such as a hairline offset or px paired with a fixed box, and the audit step in CI holds how many there are per group, a limit that only goes down.
- **One-off styling:** don't add any. Inline `style=` attributes, `!important` and hard-coded colours outside the theme blocks only go down: `tests/test_one_off_styles.py` holds each count in `index.html` and fails when one rises, and also when one falls until its ceiling there is lowered to match. Reach for a `ui.css` block, a class in `@layer app` or a theme token instead.
- **Accessibility:** required. Semantic HTML, labels on every input, Esc closes modals, `prefers-reduced-motion` is respected, WCAG AA contrast on every theme. Coloured text (`--text`, `--muted`, `--accent`, `--danger`, `--green`) reaches 4.5:1 on `--bg`, `--surface` and `--surface2`, and so does text on an accent fill. A control's edge reaches 3:1 against those surfaces through `--control-border` or its fill; `--border` is for panels and dividers. Route status dots and lines (`--status-planned`, `--status-completed`) reach 3:1 and never colour text. Place status is filled or hollow in `--text`, since colour on a place means its category. A category's colour sits in a dot beside its name, and the name itself uses `--muted`. Text on a tint of its own colour uses `--text`. Every target is at least 24px each way, and every focusable element shows a 2px `:focus-visible` ring, drawn inside fields, buttons and the map because panels clip what sticks out. `tests/test_ui_css.py` holds these in every theme.
- **Network:** edits work offline. They apply on-device immediately and sync to the server on reconnect; server-only actions (publishing, sessions, account management) still need network and fail loudly. Reads are offline-capable through a hand-rolled service worker (`sw.js`) that precaches the app shell and vendored deps, runs `stale-while-revalidate` on JSON data, and cache-firsts map tiles with an LRU cap. See [pwa.md](pwa.md).
- **Performance:** soft target under 1s first paint on a 5-year-old laptop, under 500 KB of JS+CSS+HTML on first load (tiles and GPX excluded).
- **i18n:** English UI today. Keep the language `<select>` in place so localization can be added later. Data round-trips arbitrary Unicode.
- **Privacy:** no third-party at runtime except map tile providers and the boundary search in Add > Area, which calls OpenStreetMap's Nominatim only when you press Search. No analytics, no third-party fonts, no other external APIs from the page.

## Code style

- 2-space indentation, JavaScript and Python alike.
- Comments only where the why is non-obvious. Don't document what the next line literally does.
- Match the existing nesting and naming. The frontend uses lowercase camelCase functions; the API uses `_h_` prefixed handler methods and snake_case helpers.
