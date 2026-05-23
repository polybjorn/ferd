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

```
index.html               # the app (HTML/CSS/JS in one file)
site-config.example.json # branding, default view, category labels, API base
gpx-manifest.sh          # generates routes.json from gpx/<Region>/<Trail>.gpx
tools/
  api.py                 # stdlib-only API server (auth + write endpoints)
  config.example.json    # API config template
Dockerfile               # container image for the Docker Compose path
compose.yml              # Docker Compose service definition
.dockerignore            # files excluded from the image build context
deploy/
  ferd-api.socket       # systemd socket unit
  ferd-api.service      # systemd service unit
  ferd-api.plist        # macOS launchd template
  nginx.example.conf     # nginx server block
  install.sh             # guided installer
docs/
  python.md              # running with Python
  docker.md              # running with Docker
  configure.md           # config field reference
  themes.md              # theme system + how to add one
  design.md              # UI conventions (modals, buttons, forms, status feedback)
  architecture.md        # this file
  screenshots/           # images for README and docs
tests/
  test_api_helpers.py    # unit tests for pure helpers
  test_api_integration.py# subprocess + HTTP integration tests
SECURITY.md              # account model, setup token, threat notes
CONTRIBUTING.md          # how to run, test, and submit changes
CODE_OF_CONDUCT.md       # Contributor Covenant
CHANGELOG.md             # release notes
```

## Why no build step

Two-person threshold: the project is small enough that a build step would cost more than it buys. As long as that holds, the rule is:

- Vanilla JS for the frontend.
- Stdlib only for the API. No `pip install` to run the server.
- No dependency for something that fits in fifty lines.

If you're proposing a change that breaks one of these, lead the PR with the why.
