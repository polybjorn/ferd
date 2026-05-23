# Ferd

Your own map of where you've been, where you want to go, and the journeys between them.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-blue)
![Status: 1.0](https://img.shields.io/badge/status-1.0-brightgreen)

![Unified map view](docs/screenshots/map.png)

## Quick start

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
cp tools/config.example.json tools/config.json
python3 tools/api.py
```

Open http://localhost:8091 and register the first account; that user becomes the admin. See [docs/python.md](docs/python.md) for service install, reverse proxy, and pre-seeded credentials.

**Requirements:** Python 3.9+, a modern browser. No build step, no Node, no database server (SQLite file).

## Features

**Map and data**
- One world map with clustered place pins and GPX trail polylines.
- Filter panel: per-category place toggles, visited / want chips, completed / planned trail chips.
- Browse views: places by category or country, trails by region.
- Trail detail view with elevation profile and route stats.

**Editing and multi-user**
- Sign in to add, edit, or delete places and trails from the browser. Optional GPX PII strip (timestamps, author, creator) on upload.
- Per-user data isolation. Each account has its own places and trails.
- Each user can optionally publish a read-only public copy of their map.
- Zip import/export of your own data.
- Admin tab: instance stats (users, places, trails, data and DB size), per-user management (promote/demote, revoke sessions, force-unpublish, delete), site-wide registration and publishing toggles.
- Logs tab: audit trail of auth events, publish toggles, imports, and admin actions, kept to the last 5000 entries.

**Customization**
- Multiple built-in themes, each with light and dark modes.
- Per-deployment toggle to run as places-only or trails-only.
- Per-browser settings for tile layer, distance units, marker clustering, pin style, marker size, trail thickness, and tile filter.

## Install

Two ways to run it, pick whichever fits:

- **[Docker](docs/docker.md)** - one container, one folder of data on the host. Good if you want isolation or already use Docker.
- **[Python](docs/python.md)** - two commands, no container. Instant if you have Python 3.9+.

For a public domain, front either with any reverse proxy. Sample configs in `deploy/`.

## Roadmap

- Prebuilt multi-arch container image so deployments can `docker compose pull`.
- Print / PDF stylesheet for trail and place details.
- Auth hardening: optional TOTP 2FA, HIBP breach check at register and change-password.
- Photo attachments on places and trails.
- PWA / installable shell (would unlock offline reads via a service worker).

## Documentation

| Guide | Covers |
| --- | --- |
| [Docker](docs/docker.md) | Run it in a container. |
| [Python](docs/python.md) | Run it as a plain Python process (LAN, systemd, launchd). |
| [Configuration](docs/configure.md) | Settings and feature flags you can tweak. |
| [Themes](docs/themes.md) | Look and feel options, and how to add your own. |
| [Architecture](docs/architecture.md) | How the code is organized and where data lives. |
| [API reference](docs/api.md) | Every `/api/*` endpoint, for scripting. |

