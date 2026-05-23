# Ferd

Your own map of where you've been, where you want to go, and the journeys between them.

![Unified map view](docs/screenshots/map.png)

## Features

**Map and data**
- World map with clustered place pins and GPX trail polylines.
- Filter by category, visit status, and trail completion.
- Browse places by category or country, trails by region.
- Trail detail with elevation profile and route stats.

**Editing and multi-user**
- Edit places and trails in the browser; optional GPX PII strip on upload.
- Per-user data isolation. Each account is its own map.
- Optional read-only public sharing at `/u/<username>/`.
- Per-user zip import/export.
- Admin tools: user management, site stats, registration and publishing toggles, audit log.

**Customization**
- Multiple themes, light and dark.
- Run places-only, trails-only, or both per deployment.
- Per-browser settings for tile layer, units, and appearance.

## Install

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
cp tools/config.example.json tools/config.json
python3 tools/api.py
```

Open http://localhost:8091 and register the first account; that user becomes the admin.

**Requirements:** Python 3.9+, a modern browser. No build step, no Node, no database server (SQLite file).

Prefer Docker? See [docker.md](docs/docker.md). For service install, reverse proxy, and pre-seeded credentials, see [python.md](docs/python.md). For a public domain, front either with any reverse proxy — sample configs in `deploy/`.

## Documentation

| Guide | Covers |
| --- | --- |
| [Docker](docs/docker.md) | Run it in a container. |
| [Python](docs/python.md) | Run it as a plain Python process (LAN, systemd, launchd). |
| [Configuration](docs/configure.md) | Settings and feature flags you can tweak. |
| [Themes](docs/themes.md) | Look and feel options, and how to add your own. |
| [Architecture](docs/architecture.md) | How the code is organized and where data lives. |
| [API reference](docs/api.md) | Every `/api/*` endpoint, for scripting. |

## Roadmap

- Prebuilt multi-arch container image so deployments can `docker compose pull`.
- Print / PDF stylesheet for trail and place details.
- Auth hardening: optional TOTP 2FA.
- Photo attachments on places and trails.
- Add to phone home screen as a standalone app, with offline map reads (PWA).
