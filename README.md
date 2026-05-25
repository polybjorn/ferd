# Ferd

Your own map of where you've been, where you want to go, and the journeys between them.

![Unified map view](docs/screenshots/map.png)

*Ferd is Norwegian for "journey".*

## Features

**Map and data**
- World map with clustered place pins and GPX trail polylines.
- Filter by category, visit status, and trail completion.
- Browse places by category or country, trails by region.
- Trail detail with elevation profile and route stats.
- Site catalog: browse and import community-curated places, or extend with your own.

**Editing and multi-user**
- Edit places and trails in the browser; optional GPX PII strip on upload.
- Per-user data isolation - each account is its own map.
- Optional read-only public sharing at `/u/<username>/`.
- Per-user zip import/export.
- Admin tools: user management, site stats, registration and publishing toggles, audit log.

**Customization**
- Multiple built-in themes.

**Installable and offline**
- Add to your device for launch in its own window.
- Reads work offline (app shell, last loaded data, downloaded GPX, previously viewed tiles). Edits and uploads need network.

## Install

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

**Requirements:** Python 3.9+ (or Docker), a modern browser. No build step, no Node, no database server (SQLite file).

**Footprint:** ~2 MB of code and assets. Python uses about 28 MB of memory at idle; the Docker image is 43 MiB compressed (211 MB on disk) and runs at roughly the same memory plus a small container overhead.

## Documentation

| Guide | Covers |
| --- | --- |
| [API](docs/api.md) | Every `/api/*` endpoint, for scripting. |
| [Architecture](docs/architecture.md) | How the code is organized and where data lives. |
| [Catalog](docs/catalog.md) | The site catalog: shipped baseline vs local, schema, how to contribute entries. |
| [Configuration](docs/configure.md) | Settings and feature flags you can tweak. |
| [Docker](docs/docker.md) | Run it in a container. |
| [PWA](docs/pwa.md) | Install, offline behavior, maintenance. |
| [Python](docs/python.md) | Run it as a plain Python process (LAN, systemd, launchd). |
| [Themes](docs/themes.md) | Look and feel options, and how to add your own. |

## Roadmap

- Print/PDF stylesheet for trail and place details.
- Auth hardening: optional TOTP 2FA.
- Uploaded image attachments on places and trails (today: URL only).
- Custom iOS launch splash (today: generic auto-rendered icon).
- Distinctive logo (today: placeholder favicon).
