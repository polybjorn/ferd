# Install

The fastest way to try Ferd is Docker. If you'd rather not run a container, the bare Python option is two commands. Either works for permanent use on a home network or VPN.

## With Docker

See [docker.md](docker.md) for the full walkthrough. The short version:

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
mkdir -p data
cp site-config.example.json data/site-config.json
cp .env.example .env
docker compose up -d
```

Open http://localhost:8090 and register the first account.

## With plain Python

Requires Python 3.9+. No build step, no Node, no `pip install`.

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
cp tools/config.example.json tools/config.json
python3 tools/api.py
```

Open http://localhost:8091 and register the first account. The defaults in `tools/config.json` bind to loopback and store data in the current directory.

To reach the site from other devices on your network, change `bind` to `0.0.0.0:8090` and set `secure_cookies: false` (required when there's no HTTPS in front).

### Run it as a service

For "always on" without keeping a terminal open, use your usual process manager (systemd `--user`, supervisord, a tmux session). On a Linux server with systemd available system-wide, the repo ships a guided installer that lays files at `/srv/ferd`, creates a `ferd` user, and installs socket-activated units:

```sh
sudo ./deploy/install.sh --yes
```

Audit the script first if you like (`less deploy/install.sh`); it's a couple of hundred lines of `cp`, `useradd`, and `systemctl`. macOS users: there's a `deploy/ferd-api.plist` launchd template instead. Either way, see [configure.md](configure.md) for every config knob.

## Exposing it on a public domain

Front Ferd with any reverse proxy for TLS and a clean hostname. Sample configs for the two common ones live in [`deploy/Caddyfile.example`](../deploy/Caddyfile.example) (recommended; automatic Let's Encrypt) and [`deploy/nginx.example.conf`](../deploy/nginx.example.conf) (bring your own cert).

Once HTTPS is in front, set `secure_cookies: true` (Python) or `FERD_SECURE_COOKIES=true` (Docker). The proxy forwards to the API's bind address (loopback by default).

## First-run hardening

Between starting the API and registering the first account, registration is open. If the site is reachable from the public internet during that window, a stranger can race you to claim the admin account. Three ways to close it; pick one:

1. **Don't expose the site to the internet until you've registered.** Trivial for private deploys behind a VPN or LAN.
2. **Pre-seed the admin account.** Set `initial_user` and `initial_password` in `tools/config.json` (or `FERD_INITIAL_USER` / `FERD_INITIAL_PASSWORD` for Docker). The account is created on first start and registration is already closed by the time the API accepts its first request.
3. **Require a setup token.** Set `require_setup_token: true`. The API generates a random token at startup and prints it to stderr; the first registration must supply it.

## First sign-in

Register the first account; that user becomes the admin and registration auto-closes after that. The "Settings" dialog is where most app configuration lives (appearance, publishing, sessions, admin tools); browse it once.

## Updating

Python install:

```sh
cd /path/to/source
git pull
sudo ./deploy/install.sh --yes        # if you used the guided installer
sudo systemctl restart ferd-api.service
```

Docker: see [docker.md > Updating](docker.md#updating).

Either way, your config and data are never touched.

## Backups

Two paths matter:

- `users/` (everyone's places, trails, prefs, and uploaded GPX files)
- `tools/app.db*` (users, sessions, publish flags, site-wide settings - SQLite database plus its `-shm` and `-wal` siblings)

Lose the first and you lose data. Lose the second and accounts are gone but data survives.

Simplest recipe: stop the service and tar the lot.

```sh
sudo systemctl stop ferd-api.service
sudo tar -czf ferd-$(date +%F).tar.gz -C /srv/ferd users tools/app.db tools/app.db-shm tools/app.db-wal 2>/dev/null
sudo systemctl start ferd-api.service
```

For an online backup without stopping the service, use SQLite's `.backup` for the DB and `rsync` for `users/`:

```sh
sudo -u ferd python3 -c "import sqlite3; sqlite3.connect('/srv/ferd/tools/app.db').backup(sqlite3.connect('/srv/ferd/tools/app.db.bak'))"
sudo rsync -a /srv/ferd/users/ /backup/ferd-users/
```

Docker recipe is in [docker.md > Backups](docker.md#backups). Either way, each signed-in user can also download a per-user zip export from Settings.
