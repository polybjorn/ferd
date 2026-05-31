# Ferd

Your own map of where you've been, where you want to go, and the journeys between them.

![Unified map view](docs/screenshots/map.png)

*Ferd is Norwegian for "journey".*

## Features

**Map and data**
- World map with clustered place pins and GPX route polylines.
- Filter by category, visit status, and route completion.
- Browse places by category or country, routes by region, in Grid, Compact, or Gallery layouts.
- Route detail with elevation profile and route stats.
- History page: a journal of visited places and completed routes.
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
- Local-only mode: run entirely on-device with no server or account.

## Install

**Requirements:** Python 3.9+ (or Docker), a modern browser. No build step, no Node, no database server (SQLite file).

**Footprint:** ~1.7 MB of code and assets. Python uses about 32 MB of memory at idle; the Docker image is 43 MiB compressed (211 MB on disk) and runs at roughly the same memory plus a small container overhead.

Full documentation in [docs/](docs/).

### Python

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
cp tools/config.example.json tools/config.json
python3 tools/api.py
```

Open http://localhost:8091 and register the first account. See [python.md](docs/python.md) for systemd/launchd setup, first-run hardening, and backups.

### Docker

Quickstart against [`compose.yml`](compose.yml):

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
mkdir -p data
cp site-config.example.json data/site-config.json
cp .env.example .env
docker compose up -d
```

Open http://localhost:8090 and register the first account. See [docker.md](docs/docker.md) for tag tracks, FERD_* env vars, and data folder permissions.

### Android

Android client for Ferd. Connect it to your server (enter the address on first launch) or run it fully on-device in local-only mode. Install the APK from the [latest release](https://github.com/polybjorn/ferd/releases/latest), or use an APK manager like [Obtainium](https://github.com/ImranR98/Obtainium) to install and auto-update it from the repo's releases. Build it yourself: [android/](android/README.md).

## Roadmap

### Features
- Print and PDF stylesheet for route and place details.
- Uploaded image attachments on places and routes.

### Authentication and security
- Optional TOTP two-factor authentication.

### Data and offline
- Offline editing, queued and synced when the connection returns (reads already work offline).

### Branding
- Distinctive logo.
- Custom iOS launch splash (PWA).
- Custom Android launcher icon.
- Custom social preview image for the GitHub repository.
