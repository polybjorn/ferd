# Ferd

Your own map of where you've been, where you want to go, and the journeys between them.

![Unified map view](docs/screenshots/map.png)

*Ferd is Norwegian for "journey".*

## Features

**Map and data**
- World map with clustered place pins and GPX route polylines.
- Filter by category, visit status, and route completion.
- Browse places by category or country, routes by region.
- Route detail with elevation profile and route stats.
- Site catalog: browse and import community-curated places, or extend with your own.
- Multiple built-in UI themes.
- Pick a map tile layer independent of the theme, with adjustable filters.

**Multi-user**
- Per-user data isolation - each account is its own map.
- Optional read-only public sharing at `/u/<username>/`.
- Admin tools: user management, site stats, registration and publishing toggles.

**Installable and offline**
- Add to your device for launch in its own window.
- Reads work offline (app shell, last loaded data, downloaded GPX, previously viewed tiles). Edits and uploads need network.

## Install

**Requirements:** Python 3.9+ (or Docker), a modern browser. No build step, no Node, no database server (SQLite file).

**Footprint:** ~2 MB of code and assets. Python uses about 28 MB of memory at idle; the Docker image is 43 MiB compressed (211 MB on disk) and runs at roughly the same memory plus a small container overhead.

For configuration, themes, the catalog, PWA install, the API, and architecture notes, see [docs/](docs/).

### Python

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
cp tools/config.example.json tools/config.json
python3 tools/api.py
```

Open http://localhost:8091 and register the first account; that user becomes the admin. See [python.md](docs/python.md) for systemd/launchd service install, reverse proxy, and pre-seeded credentials.

### Docker

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
mkdir -p data
cp site-config.example.json data/site-config.json
cp .env.example .env
docker compose up -d
```

Open http://localhost:8090 and register the first account. See [docker.md](docs/docker.md) for tag tracks, reverse proxy, and updates.

## Roadmap

### Features
- Print and PDF stylesheet for route and place details.
- Uploaded image attachments on places and routes.

### Authentication and security
- Optional TOTP two-factor authentication.
- Bearer-token authentication for non-browser clients.

### Native clients
- Configurable API base URL with a server-picker screen.
- Android application via Trusted Web Activity.

### Branding
- Distinctive logo.
- Custom iOS launch splash (PWA).
- Custom social preview image for the GitHub repository.
