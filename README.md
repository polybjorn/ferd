# Atlas

Your own map of where you've been, where you want to go, and the journeys between them.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-blue)
![Status: 1.0](https://img.shields.io/badge/status-1.0-brightgreen)

![Unified map view](docs/screenshots/map.png)

## Quick start

```sh
git clone https://github.com/polybjorn/atlas.git
cd atlas
cp site-config.example.json site-config.json
python3 tools/api.py
```

Open http://localhost:8090 and sign in with the seeded admin account (see [docs/install.md](docs/install.md) for default credentials and first-run setup).

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

**Customization**
- Multiple built-in themes, each with light and dark modes.
- Per-deployment toggle to run as places-only or trails-only.
- Per-browser settings for tile layer, distance units, marker clustering, pin style, marker size, trail thickness, and tile filter.

## Install

Three paths, pick the one that fits:

- **Static only.** Drop the files on any static host. No Python, no in-browser editing.
- **Local / private network.** Run `python3 tools/api.py` directly. Good for LAN or a mesh overlay (WireGuard, Tailscale, ZeroTier).
- **Public internet.** Reverse proxy in front, socket-activated systemd, TLS. Guided installer at `deploy/install.sh` or step-by-step manual instructions.

Full walk-through in [docs/install.md](docs/install.md). Docker path in [docs/docker.md](docs/docker.md).

## Roadmap

- Move trails between regions from the trail edit modal (rename/delete-empty/clear-region already shipped via Manage regions).
- Stable category colors across config edits. Colors can currently shift when categories are added or reordered.
- Publish a prebuilt multi-arch container image so deployments can `docker compose pull` instead of building from source.

## Documentation

| Guide | Covers |
| --- | --- |
| [Install](docs/install.md) | How to set up Atlas on your own server. |
| [Docker](docs/docker.md) | How to run Atlas in a container. |
| [Configuration](docs/configure.md) | Settings and feature flags you can tweak. |
| [Themes](docs/themes.md) | Look and feel options, and how to add your own. |
| [Architecture](docs/architecture.md) | How the code is organized and where data lives. |

