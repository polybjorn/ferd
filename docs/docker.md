# Running with Docker

If you'd rather run it as a plain Python process, see [python.md](python.md).

## What you get

- A single `ferd` container running the API on port 8090.
- A `./data/` folder on the host that holds everything: the SQLite database, per-user folders (places, GPX files, preferences), and `site-config.json`. Nothing important lives inside the container itself, so pulling a new image never touches your data.

## Quickstart

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
mkdir -p data
cp site-config.example.json data/site-config.json
cp .env.example .env
docker compose up -d
```

This pulls `ghcr.io/polybjorn/ferd:latest` and runs it. Open http://localhost:8090 and register the first account; that user can change site-wide settings, everyone after is a regular user.

To reach it from other devices on your LAN, the container already listens on every interface, so use `http://<host-ip>:8090`.

## Which tag to pick

Ferd publishes multi-arch (amd64, arm64) images to GitHub Container Registry:

| Tag | What it is | When to pick it |
|---|---|---|
| `ghcr.io/polybjorn/ferd:latest` | Newest tagged stable release | Default. Predictable updates, only changes when a new version ships. |
| `ghcr.io/polybjorn/ferd:dev` | Tip of the `main` branch | Early access to in-progress changes. Rebuilt on every commit; may break. |
| `ghcr.io/polybjorn/ferd:1.0.0`, `:1.0`, `:1` | Pinned stable release | Hold a specific version forever. |

To switch tags, edit the `image:` line in [`compose.yml`](../compose.yml), then `docker compose pull && docker compose up -d`.

You can check which version is running under Menu -> About in the app, or hit `/api/state` and look at the `version` field.

## What the compose file does

Trimmed for readability; the full file is at [`compose.yml`](../compose.yml) (env vars, healthcheck, PUID/PGID auto-detection).

```yaml
services:
  ferd:
    image: ghcr.io/polybjorn/ferd:latest
    restart: unless-stopped
    ports:
      - "8090:8090"
    volumes:
      - ./data:/data
    environment:
      FERD_SECURE_COOKIES: "false"
```

One container, one bind-mount (`./data` -> `/data`). All persistent state lives in that one folder.

## Behind a reverse proxy

To reach the app at an `https://` URL on your own domain, put a reverse proxy in front of it. Caddy is the friendliest option (it fetches a free Let's Encrypt certificate automatically). nginx, Traefik, and others work the same way.

Two common setups:

- **You already run a proxy on the host.** Keep the `ports: 8090:8090` mapping in [`compose.yml`](../compose.yml) and tell your existing proxy to forward to `http://127.0.0.1:8090`. [`deploy/Caddyfile.example`](../deploy/Caddyfile.example) and [`deploy/nginx.example.conf`](../deploy/nginx.example.conf) are starting points.
- **You run the proxy as a second container alongside the app.** Add a Caddy, nginx, or Traefik service to [`compose.yml`](../compose.yml), remove the `ports:` block from the `ferd` service so only the proxy can reach it, and tell the proxy to forward to `ferd:8090`.

Either way, set `FERD_SECURE_COOKIES=true` in `.env` once you're on HTTPS. This marks login cookies as HTTPS-only so they can't leak over plain HTTP by accident.

## Permissions and the data folder

Bind-mounted data folders are the most common source of "it broke for no reason" issues with Docker. The entrypoint handles this for you, but here's what's actually happening so nothing looks suspicious if you read the Dockerfile:

- The container starts as root, then immediately drops to a non-root `ferd` user using `gosu`. It does not stay root.
- Before dropping, the entrypoint figures out which user/group the `ferd` user should be by reading the owner of `./data/`. That's almost always you, the person who ran `mkdir data`. So the container runs as your uid/gid, and files in `./data/` stay owned by you on the host.
- If you'd rather pin a specific uid/gid (say, on a NAS where the data lives under a service account), set `PUID` and `PGID` in `.env`. Those win over auto-detection.
- If `./data/` is root-owned (for example, you created it with `sudo`), the entrypoint falls back to uid/gid `1000:1000` and chowns the folder once.

This is the same family of pattern as LinuxServer.io's images, just with an auto-detect default instead of asking everyone to set `PUID`/`PGID` manually.

## Configuration

Per-deployment settings live in `.env` on the host (gitignored; `.env.example` is the template you copy from). Compose reads `.env` and passes the values into the container. The variables you'll actually want to set:

| Variable | Default | What it does |
|---|---|---|
| `FERD_SECURE_COOKIES` | `true` in image, `false` in `.env.example` | Set to `false` only for plain-HTTP localhost. `true` whenever there's a reverse proxy with TLS in front. |
| `FERD_INITIAL_USER` | unset | Pre-create an admin account on first start, instead of registering through the web UI. Used together with `FERD_INITIAL_PASSWORD`. Ignored once any user exists. |
| `FERD_INITIAL_PASSWORD` | unset | Password for the seeded admin account. |
| `FERD_REQUIRE_SETUP_TOKEN` | `false` | When `true`, the first registration requires a one-time token printed to the container log at startup. Recommended for anything internet-facing. |
| `PUID` / `PGID` | auto-detect | Pin the container's uid/gid instead of adopting the owner of `./data/`. See the Permissions section above. |

Every other key in `tools/config.json` can also be set as an `FERD_*` environment variable; see [configure.md](configure.md) for the full list. The container-internal paths (bind address, database path, data dir, static dir, manifest command) have sensible defaults baked into the image and almost never need overriding.

## Health check

The image includes a `HEALTHCHECK` that pings `http://127.0.0.1:8090/` every 30 seconds. `docker ps` will show whether the container is healthy, and a reverse-proxy sidecar can wait for it to be ready using `depends_on: condition: service_healthy`.

## Backups

For a single user backing up their own places and trails, the easiest option is the zip export under Settings in the app. It downloads as a normal file in the browser and re-imports through the same UI. No host access needed.

For a full-server backup (all users, the database, and `site-config.json`), everything you need is in `./data/`. The simplest way is to tar it:

```sh
tar -czf backup-$(date +%F).tar.gz data/
```

For a guaranteed-consistent snapshot, stop the container first. Or use SQLite's online backup, which works while the server is running:

```sh
docker compose exec ferd python3 -c \
  "import sqlite3; sqlite3.connect('/data/app.db').backup(sqlite3.connect('/data/app.db.bak'))"
```

## Updating

```sh
docker compose pull
docker compose up -d
```

`./data/` is untouched and schema migrations run on the next start. If you've switched to `build: .` for contributing, swap `pull` for `build`.

## Uninstall

```sh
docker compose down
rm -rf data/
```

## What's in the image

Base is `python:3.12-slim`. The only added packages are `tini` (clean signal handling) and `gosu` (drop privileges in the entrypoint). The API is stdlib-only Python, so there's no `pip install` step and no Python packages baked in. Around 43 MB compressed, 210 MB on disk; the app's own footprint is under 5 MB and the rest is the Debian-slim Python base.
