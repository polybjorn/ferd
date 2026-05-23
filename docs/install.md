# Install

Two reasonable install shapes, in increasing order of moving parts. Pick the one that matches how you plan to use it.

| Setup | API | Reverse proxy | TLS | Good for |
|---|---|---|---|---|
| [Local / private network](#1-local--private-network) | yes | no | no | LAN, VPN, mesh overlay |
| [Public internet](#2-public-internet) | yes | yes | yes | the open web |

Prerequisites are minimal: Python 3.9+ on the host. No build step, no Node. The API is required: every data read and write goes through it.

Prefer containers? There's a Docker path too, mapping onto the same two shapes. See [docker.md](docker.md).

## 1. Local / private network

If the host is only reachable on your LAN or via a private VPN / mesh overlay (e.g. WireGuard, Tailscale, ZeroTier), the API can listen directly. No reverse proxy, no certs.

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
cp tools/config.example.json tools/config.json
```

Edit `tools/config.json`:

```json
{
  "bind": "0.0.0.0:8090",
  "db_path": "tools/app.db",
  "data_dir": ".",
  "manifest_cmd": "./gpx-manifest.sh",
  "secure_cookies": false,
  "initial_user": "admin",
  "initial_password": "change-me"
}
```

`secure_cookies: false` is required for plain HTTP. Bind to `0.0.0.0` to accept LAN connections, or to a specific interface IP (e.g. a VPN-assigned address) to limit exposure to that network.

Run it:

```sh
python3 tools/api.py
```

For "always on", drop it under your usual process manager (systemd `--user`, a tmux session, screen, supervisord). Or jump to the public-internet setup below and use the shipped socket-activated unit.

## 2. Public internet

The full setup: app behind a system service, reverse proxy in front, TLS at the proxy. Two paths to get there - a guided script, or step-by-step manual.

### 2a. Guided install (recommended)

The repo ships `deploy/install.sh`. It lays files at `/srv/ferd`, creates a `ferd` system user, and installs the socket-activated systemd units. It does not download anything, does not edit your proxy config, and prompts before each destructive step.

Audit before running (this is a normal precaution, not a sign of mistrust - the script is ~150 lines of `cp`, `useradd`, `systemctl`):

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
less deploy/install.sh                    # read it
sudo ./deploy/install.sh                  # run it, prompts at each step
# or, non-interactive:
sudo ./deploy/install.sh --yes
# or, different layout:
sudo ./deploy/install.sh --prefix=/opt/ferd --user=ferd --yes
```

When it finishes:

1. Edit `/srv/ferd/tools/config.json` (see [docs/configure.md](configure.md)). At minimum set `secure_cookies: true` and decide between pre-seeded credentials (`initial_user` + `initial_password`) or in-browser registration.
2. Set up the reverse proxy (see [2c](#2c-reverse-proxy)).
3. Open the site, register the first account (or log in with the seeded credentials). The first registrant becomes the admin. Existing data living at the `data_dir` root (`places.json`, `routes.json`, `metadata.json`, `gpx/`) is moved into that admin's `users/<admin>/` folder on first start.

To reverse it: `sudo /srv/ferd/deploy/uninstall.sh` (add `--purge` to also delete the install prefix and its data).

### 2b. Manual install

Same outcome, every command visible. Use this if you'd rather not run a script, or you're deploying somewhere weird.

```sh
# Lay out the files.
sudo useradd --system --home /srv/ferd --shell /usr/sbin/nologin ferd
sudo install -d -o ferd -g ferd /srv/ferd /srv/ferd/tools /srv/ferd/gpx
sudo cp index.html favicon.svg gpx-manifest.sh site-config.example.json /srv/ferd/
sudo cp tools/api.py tools/config.example.json /srv/ferd/tools/
sudo cp /srv/ferd/site-config.example.json /srv/ferd/site-config.json
sudo cp /srv/ferd/tools/config.example.json /srv/ferd/tools/config.json
sudo chown -R ferd:ferd /srv/ferd

# Edit /srv/ferd/tools/config.json. Minimum:
#   "bind": "127.0.0.1:8091"
#   "db_path": "/srv/ferd/tools/app.db"
#   "data_dir": "/srv/ferd"
#   "manifest_cmd": "/srv/ferd/gpx-manifest.sh"
#   "secure_cookies": true

# Install the systemd units.
sudo cp deploy/ferd-api.socket  /etc/systemd/system/
sudo cp deploy/ferd-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ferd-api.socket
```

How the units work:
- `ferd-api.socket` holds port 8091 on loopback at zero RAM cost.
- The first request triggers `ferd-api.service` to start.
- After `idle_exit_seconds` of no activity the Python process exits. The socket stays held; the next request wakes it.

If you put files somewhere other than `/srv/ferd`, edit `WorkingDirectory`, `ExecStart`, and `ReadWritePaths` in the service unit accordingly.

### 2c. Reverse proxy

Pick one. Both example configs are in `deploy/`.

**Caddy** (recommended for new setups - automatic Let's Encrypt):

```sh
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo $EDITOR /etc/caddy/Caddyfile            # replace ferd.example.com and /srv/ferd
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy provisions and renews the certificate on its own. Port 80 and 443 must be reachable from the internet for the ACME challenge.

**nginx** (if you already run nginx):

```sh
sudo cp deploy/nginx.example.conf /etc/nginx/sites-available/ferd
sudo $EDITOR /etc/nginx/sites-available/ferd    # replace ferd.example.com, paths, cert paths
sudo ln -s /etc/nginx/sites-available/ferd /etc/nginx/sites-enabled/ferd
sudo nginx -t && sudo systemctl reload nginx
```

You provision the cert yourself (certbot, acme.sh). nginx's example also includes a `/api/login` rate limit at the proxy layer.

Either way, the API has its own internal rate limit on login, so the proxy-side limit is defense in depth.

### 2d. First-run hardening

Between starting the API and registering the first account, registration is open. If the site is reachable from the public internet during that window, a stranger can race you to claim the admin account. Three ways to close it; pick one:

1. **Don't expose the site to the public internet until you've registered.** Trivial for private deploys behind a VPN or LAN; for a public deploy, gate the proxy until the account exists.
2. **Pre-seed the admin account.** Set `initial_user` and `initial_password` in `tools/config.json`. On first start with no users, the account is created and registration is already closed by the time the API accepts its first request.
3. **Require a setup token.** Set `require_setup_token: true`. On first start the API generates a random token and prints it to stderr (in the systemd journal, `journalctl -u ferd-api`). Registration is open but the first registration must supply the token. The token is consumed once the first account exists.

### macOS (launchd)

Same shape, but use `deploy/ferd-api.plist` (template; replace `/Users/YOU/ferd`). launchd does not have systemd-style socket activation, so set `idle_exit_seconds: 0` in `tools/config.json` so the process stays up.

## First sign-in

Open the site and either log in with the seeded credentials or register the first account; that user becomes the admin and registration auto-closes. Existing data living at the `data_dir` root (`places.json`, `routes.json`, `metadata.json`, `gpx/`) is moved into the admin's `users/<admin>/` folder on first start. The "Settings" dialog is where most app configuration lives (appearance, publishing, sessions, admin tools); browse it once.

## Updating

```sh
cd /path/to/source
git pull
sudo ./deploy/install.sh --yes
sudo systemctl restart ferd-api.service
```

The installer never overwrites your config (`tools/config.json`, `site-config.json`) or data (`users/`, `tools/app.db`). Only application files and the systemd units are replaced.

## Backups

Two paths matter:

- `users/` (everyone's places, trails, prefs, and uploaded GPX files; symlinks within are followed at write time)
- `tools/app.db*` (users, sessions, publish flags, site-wide settings - SQLite database plus `-shm` and `-wal` siblings)

Lose the first and you lose data. Lose the second and you have to register a new account but your data survives.

Simplest recipe: stop the service and tar the lot.

```sh
sudo systemctl stop ferd-api.service
sudo tar -czf ferd-$(date +%F).tar.gz -C /srv/ferd users tools/app.db tools/app.db-shm tools/app.db-wal 2>/dev/null
sudo systemctl start ferd-api.service
```

For an online backup without stopping the service, use SQLite's `.backup` for the DB and rsync `users/` separately:

```sh
sudo -u ferd python3 -c "import sqlite3; sqlite3.connect('/srv/ferd/tools/app.db').backup(sqlite3.connect('/srv/ferd/tools/app.db.bak'))"
sudo rsync -a /srv/ferd/users/ /backup/ferd-users/
```

Each signed-in user can also download a per-user zip export from Settings - useful for single-account self-backup without host access.
