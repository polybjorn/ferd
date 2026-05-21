# Installing with Docker

The easiest way to run Atlas on a server, NAS, or a spare machine at home. One container, one folder of your data on the host, and (if you want it on the public internet) a reverse proxy in front for TLS. The bare-metal install path in [install.md](install.md) is still there if you'd rather skip Docker.

## What you get

- A single `atlas` container running the API on port 8090.
- A `./data/` folder on the host that holds everything: the SQLite database, per-user folders (places, GPX files, preferences), and `site-config.json`. Nothing important lives inside the container itself, so rebuilding the image never touches your data.
- A small image: about 43 MB compressed to pull, around 210 MB on disk after extract. Atlas's own footprint is under 5 MB; the rest is the Debian-slim Python base.

## Quickstart

```sh
git clone https://github.com/polybjorn/atlas.git
cd atlas
mkdir -p data
cp site-config.example.json data/site-config.json
cp .env.example .env
docker compose up -d
```

Open http://localhost:8090 and register the first account. That account becomes the operator (the one user who can change site-wide settings).

To reach it from other devices on your LAN, the container already listens on every interface, so use `http://<host-ip>:8090`. `ATLAS_SECURE_COOKIES` defaults to `false` in `.env.example` because the quickstart assumes plain HTTP.

There isn't a published image yet (it's on the roadmap). For now the quickstart builds locally. Once published, the workflow becomes `docker compose pull && docker compose up -d` without the `git clone`.

## Running on the public internet

Same container, but put a reverse proxy in front for TLS. Two common shapes:

- **A reverse proxy already on the host** (Caddy, nginx, Traefik, anything else). Keep the `ports: 8090:8090` mapping and proxy from there. `deploy/Caddyfile.example` and `deploy/nginx.example.conf` are starting points: point the upstream at `http://127.0.0.1:8090`.
- **A proxy as a sidecar container.** Add a Caddy or nginx service to `compose.yml`, drop the `ports:` block from the `atlas` service (so it's only reachable on Docker's internal network), and proxy to `atlas:8090`.

Either way, set `ATLAS_SECURE_COOKIES=true` in `.env`.

## Permissions and the data folder

Bind-mounted data folders are the most common source of "it broke for no reason" issues with Docker. Atlas handles this for you, but here's what's actually happening so nothing looks suspicious if you read the Dockerfile:

- The container starts as root, then immediately drops to a non-root `atlas` user using `gosu`. It does not stay root.
- Before dropping, the entrypoint figures out which user/group the `atlas` user should be by reading the owner of `./data/`. That's almost always you, the person who ran `mkdir data`. So the container runs as your uid/gid, and files in `./data/` stay owned by you on the host.
- If you'd rather pin a specific uid/gid (say, on a NAS where the data lives under a service account), set `PUID` and `PGID` in `.env`. Those win over auto-detection.
- If `./data/` is root-owned (for example, you created it with `sudo`), the entrypoint falls back to uid/gid `1000:1000` and chowns the folder once.

This is the same family of pattern as LinuxServer.io's images, just with an auto-detect default instead of asking everyone to set `PUID`/`PGID` manually.

## Configuration

Per-deployment settings live in `.env` on the host (gitignored; `.env.example` is the template you copy from). Compose reads `.env` and passes the values into the container. Every key in `tools/config.json` can also be set as an `ATLAS_*` environment variable; see [configure.md](configure.md) for the full list.

The container ships with these defaults:

| Variable | Default | What it does |
|---|---|---|
| `ATLAS_BIND` | `0.0.0.0:8090` | Accept connections from outside the container |
| `ATLAS_DB_PATH` | `/data/atlas.db` | Where the SQLite database lives on the volume |
| `ATLAS_DATA_DIR` | `/data` | Where all operator data lives on the volume |
| `ATLAS_STATIC_DIR` | `/app` | Serves the frontend from the same origin as the API |
| `ATLAS_MANIFEST_CMD` | `/app/gpx-manifest.sh` | Regenerates the GPX manifest after uploads |
| `ATLAS_SECURE_COOKIES` | `true` | Override to `false` only for plain-HTTP localhost |

Common overrides you'll want in `.env`:

| Variable | Default | What it does |
|---|---|---|
| `ATLAS_INITIAL_USER` | unset | Pre-create an operator account on first start, instead of registering through the web UI. Used together with `ATLAS_INITIAL_PASSWORD`. Ignored once any user exists. |
| `ATLAS_INITIAL_PASSWORD` | unset | Password for the seeded operator account. |
| `ATLAS_REQUIRE_SETUP_TOKEN` | `false` | When `true`, the first registration requires a one-time token printed to the container log at startup. Recommended for anything internet-facing. |
| `PUID` / `PGID` | auto-detect | Pin the container's uid/gid instead of adopting the owner of `./data/`. See the Permissions section above. |

## Health check

The image includes a `HEALTHCHECK` that pings `http://127.0.0.1:8090/` every 30 seconds. `docker ps` will show whether the container is healthy, and a reverse-proxy sidecar can wait for Atlas to be ready using `depends_on: condition: service_healthy`.

## Backups

Everything you need to back up is in `./data/`. Tar it:

```sh
tar -czf atlas-backup-$(date +%F).tar.gz data/
```

For a guaranteed-consistent snapshot, stop the container first. Or use SQLite's online backup, which works while Atlas is running:

```sh
docker compose exec atlas python3 -c \
  "import sqlite3; sqlite3.connect('/data/atlas.db').backup(sqlite3.connect('/data/atlas.db.bak'))"
```

## Updating

For the current source-build flow:

```sh
git pull
docker compose build
docker compose up -d
```

Once a prebuilt image is published, this becomes:

```sh
docker compose pull
docker compose up -d
```

Either way, `./data/` is untouched and schema migrations run on the next start.

## Uninstall

```sh
docker compose down
rm -rf data/
docker image rm atlas:local
```

## How the image is put together

A few details worth knowing if you ever debug the container or build your own variant:

- The base is `python:3.12-slim`. The only added packages are `tini` (clean signal handling) and `gosu` (drop privileges in the entrypoint). Atlas is stdlib-only Python, so there's no `pip install` step and no Python packages baked in.
- Inside the image, `/app/site-config.json` is a symlink that points at `/data/site-config.json` on the volume. The frontend fetches it as a static asset and the API writes to it through `data_dir`; the symlink keeps both pointing at the same file. Atlas's static-file handler follows symlinks intentionally (the same mechanism the `gpx/` mount uses on bare-metal installs).
- The Docker and bare-metal install paths don't share any state. Pick one per host.
