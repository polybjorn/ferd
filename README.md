# Atlas

A self-hosted Leaflet map for travel places and GPX trails. Single-file static frontend, optional Python API for in-browser editing. No build step, no Docker.

![Unified map view](docs/screenshots/map.png)

**Docs:** [Install](docs/install.md) · [Configuration](docs/configure.md) · [Themes](docs/themes.md)

## Features

- One world map with clustered place pins and GPX trail polylines.
- Filter panel: per-category place toggles, visited / want chips, completed / planned trail chips.
- Browse views: places grouped by category or country, trails grouped by region.
- Trail detail view with elevation profile and route stats.
- Sign in to add, edit, or delete places and trails from the browser. Server strips PII from uploaded GPX (timestamps, author, creator).
- Seven themes (Catppuccin, Dracula, Gruvbox, Nord, Rosé Pine, Solarized, Tokyo Night), each with system / light / dark mode.
- Per-deployment toggle to run as places-only or trails-only; per-browser settings for default tile layer, distance units (metric / imperial), marker clustering, remembering the last map view, pin style (ring / pin / dot / flag), marker size, trail line thickness, and map tile filter.
- Operator can edit category display labels from the Settings UI.
- Works read-only without the API; the static site loads `places.json` and `routes.json` directly.

## Install

Three tiers, pick the one that matches your use case:

- **Static only** - drop the files on any static host, no Python, no editing in-browser.
- **Local / private network** - run `python3 tools/api.py` directly; good for LAN or Tailscale.
- **Public internet** - reverse proxy (Caddy or nginx), socket-activated systemd, TLS. Guided installer in `deploy/install.sh` or step-by-step manual instructions.

See [docs/install.md](docs/install.md) for the full walk-through.

## TODO

- UI to manage trail regions (rename, move trails between regions, delete), like the existing category-label editor.
- Per-user maps. Each user has their own places + trails, fully isolated from other users; the operator's job narrows to user management and instance-wide settings. Replaces the current single-shared-map model. Includes an export feature so users can take their data with them, and an optional per-user "publish my map" toggle that exposes a read-only public URL (no login required to view a published map). Until this lands, writes are operator-only.
- Stable category colors. Pin/text colors are currently assigned by sorted category position, so adding a new category alphabetically before existing ones reshuffles colors for everything after it. Persist assignments in `site-config.json` to fix.
- Avoid full map re-render on place CRUD. Add/edit/delete currently calls `router()` after a successful write, which tears down and rebuilds the Leaflet layers. Add/remove only the affected marker (and refresh cluster + filter panel) instead.
