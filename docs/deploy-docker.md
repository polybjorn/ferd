# Docker Compose deploy

Alternative to the bare-metal install in [install.md](install.md). One container, one volume, optionally a reverse proxy in front for TLS. Same code, same data layout, same upgrade story.

## What you get

- A single `atlas` service running the API on port 8090.
- A `./data/` directory on the host that holds everything stateful: the SQLite database, per-user folders (places, GPX, prefs), and `site-config.json`.
- No code or operator data baked into the image. Rebuilding never touches your data.

## Quickstart (local / private network)

```sh
git clone https://github.com/polybjorn/atlas.git
cd atlas
mkdir -p data
cp site-config.example.json data/site-config.json
docker compose up -d
```

Open http://localhost:8090 and register the first account. That user becomes the operator.

For LAN access, the published port `8090:8090` already binds to `0.0.0.0`. Reach it from other devices as `http://<host-ip>:8090`. `ATLAS_SECURE_COOKIES` is `false` by default in `compose.yml` because the quickstart assumes plain HTTP.

## Public internet

Same container, add TLS at a reverse proxy. Two paths:

### Caddy in a sidecar

Add to `compose.yml`:

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - atlas

volumes:
  caddy_data:
  caddy_config:
```

Create `Caddyfile` at the repo root:

```caddy
atlas.example.com {
  reverse_proxy atlas:8090
}
```

Then drop the `ports:` block from the `atlas` service (proxy talks to it on the internal network) and set `ATLAS_SECURE_COOKIES: "true"`.

### Existing host-level proxy

If you already run Caddy or nginx on the host, leave the `ports: 8090:8090` mapping and proxy from the host. Use `deploy/Caddyfile.example` or `deploy/nginx.example.conf` as a starting point - replace the upstream with `http://127.0.0.1:8090`. Set `ATLAS_SECURE_COOKIES: "true"` in `compose.yml`.

## Configuration

Every key in `tools/config.json` can be set via an `ATLAS_*` environment variable in `compose.yml`. See [configure.md](configure.md) for the full list. The container sets sensible defaults:

| Variable | Default in image | Why |
|---|---|---|
| `ATLAS_BIND` | `0.0.0.0:8090` | Accept connections from outside the container |
| `ATLAS_DB_PATH` | `/data/atlas.db` | Persist on the bind-mounted volume |
| `ATLAS_DATA_DIR` | `/data` | All operator data on the volume |
| `ATLAS_STATIC_DIR` | `/app` | Same-origin serving from the image |
| `ATLAS_MANIFEST_CMD` | `/app/gpx-manifest.sh` | GPX manifest regeneration |
| `ATLAS_SECURE_COOKIES` | `true` | Override to `false` only for plain-HTTP localhost |

Common overrides in `compose.yml`:

- `ATLAS_INITIAL_USER` / `ATLAS_INITIAL_PASSWORD`: seed an operator account on first start. Ignored once any user exists.
- `ATLAS_REQUIRE_SETUP_TOKEN: "true"`: require a one-time token (printed to the container log) for the first registration. Recommended for public deploys.
- `ATLAS_IDLE_EXIT_SECONDS`: not useful in a container; restart policy fights it.

## Backups

Everything stateful lives in `./data/`. Tar it:

```sh
tar -czf atlas-backup-$(date +%F).tar.gz data/
```

Stop the container first if you want a consistent snapshot, or use SQLite's `.backup` from inside the container:

```sh
docker compose exec atlas python3 -c \
  "import sqlite3; sqlite3.connect('/data/atlas.db').backup(sqlite3.connect('/data/atlas.db.bak'))"
```

## Updating

```sh
git pull
docker compose build
docker compose up -d
```

The image is rebuilt with the new code; `./data/` is untouched. Schema migrations run on next start.

## Uninstall

```sh
docker compose down
rm -rf data/
docker image rm atlas:local
```

## Implementation notes

- The image is `python:3.12-slim` + `bash` (for `gpx-manifest.sh`) + `tini`. No Python packages installed; Atlas is stdlib-only.
- Runs as a non-root user (uid 1000). Bind-mounted `./data/` ends up owned by the same uid on the host, which usually matches your user.
- `/app/site-config.json` is a symlink to `/data/site-config.json` inside the image. The frontend fetches it as a static asset, and the API writes it through `data_dir`; the symlink keeps both pointing at the same file. The static handler follows symlinks by design (same mechanism the `gpx/` mount uses on bare-metal installs).
- The bare-metal install path in [install.md](install.md) still works. The two share no state; pick one per host.
