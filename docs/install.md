# Install

Atlas has two reasonable install shapes, in increasing order of moving parts. Pick the one that matches how you plan to use it.

| Tier | API | Reverse proxy | TLS | Good for |
|---|---|---|---|---|
| [1. Local / private network](#1-local--private-network) | yes | no | no | LAN, VPN, mesh overlay |
| [2. Public internet](#2-public-internet) | yes | yes | yes | the open web |

Prerequisites are minimal: Python 3.9+ on the host. No build step, no Node. The API is required: every data read and write goes through it.

Prefer containers? Atlas also ships a Docker path that maps onto the same two tiers. See [docker.md](docker.md).

## 1. Local / private network

If the host is only reachable on your LAN or via a private VPN / mesh overlay (e.g. WireGuard, Tailscale, ZeroTier), the API can listen directly. No reverse proxy, no certs.

```sh
git clone https://github.com/polybjorn/atlas.git
cd atlas
cp tools/config.example.json tools/config.json
```

Edit `tools/config.json`:

```json
{
  "bind": "0.0.0.0:8090",
  "db_path": "tools/atlas.db",
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

For "always on", drop it under your usual process manager (systemd `--user`, a tmux session, screen, supervisord). Or jump to tier 2 and use the shipped socket-activated unit.

## 2. Public internet

The full setup: app behind a system service, reverse proxy in front, TLS at the proxy. Two paths to get there - a guided script, or step-by-step manual.

### 2a. Guided install (recommended)

The repo ships `deploy/install.sh`. It lays files at `/srv/atlas`, creates a `atlas` system user, and installs the socket-activated systemd units. It does not download anything, does not edit your proxy config, and prompts before each destructive step.

Audit before running (this is a normal precaution, not a sign of mistrust - the script is ~150 lines of `cp`, `useradd`, `systemctl`):

```sh
git clone https://github.com/polybjorn/atlas.git
cd atlas
less deploy/install.sh                    # read it
sudo ./deploy/install.sh                  # run it, prompts at each step
# or, non-interactive:
sudo ./deploy/install.sh --yes
# or, different layout:
sudo ./deploy/install.sh --prefix=/opt/atlas --user=atlas --yes
```

When it finishes:

1. Edit `/srv/atlas/tools/config.json` (see [docs/configure.md](configure.md)). At minimum set `secure_cookies: true` and decide between pre-seeded credentials (`initial_user` + `initial_password`) or in-browser registration.
2. Set up the reverse proxy (see [2c](#2c-reverse-proxy)).
3. Open the site, register the first account (or log in with the seeded credentials). The first registrant becomes the operator. Existing data living at the `data_dir` root (`places.json`, `routes.json`, `metadata.json`, `gpx/`) is moved into that operator's `users/<operator>/` folder on first start.

To reverse it: `sudo /srv/atlas/deploy/uninstall.sh` (add `--purge` to also delete the install prefix and its data).

### 2b. Manual install

Same outcome, every command visible. Use this if you'd rather not run a script, or you're deploying somewhere weird.

```sh
# Lay out the files.
sudo useradd --system --home /srv/atlas --shell /usr/sbin/nologin atlas
sudo install -d -o atlas -g atlas /srv/atlas /srv/atlas/tools /srv/atlas/gpx
sudo cp index.html favicon.svg gpx-manifest.sh site-config.example.json /srv/atlas/
sudo cp tools/api.py tools/config.example.json /srv/atlas/tools/
sudo cp /srv/atlas/site-config.example.json /srv/atlas/site-config.json
sudo cp /srv/atlas/tools/config.example.json /srv/atlas/tools/config.json
sudo chown -R atlas:atlas /srv/atlas

# Edit /srv/atlas/tools/config.json. Minimum:
#   "bind": "127.0.0.1:8091"
#   "db_path": "/srv/atlas/tools/atlas.db"
#   "data_dir": "/srv/atlas"
#   "manifest_cmd": "/srv/atlas/gpx-manifest.sh"
#   "secure_cookies": true

# Install the systemd units.
sudo cp deploy/atlas-api.socket  /etc/systemd/system/
sudo cp deploy/atlas-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-api.socket
```

How the units work:
- `atlas-api.socket` holds port 8091 on loopback at zero RAM cost.
- The first request triggers `atlas-api.service` to start.
- After `idle_exit_seconds` of no activity the Python process exits. The socket stays held; the next request wakes it.

If you put files somewhere other than `/srv/atlas`, edit `WorkingDirectory`, `ExecStart`, and `ReadWritePaths` in the service unit accordingly.

### 2c. Reverse proxy

Pick one. Both example configs are in `deploy/`.

**Caddy** (recommended for new setups - automatic Let's Encrypt):

```sh
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo $EDITOR /etc/caddy/Caddyfile            # replace atlas.example.com and /srv/atlas
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy provisions and renews the certificate on its own. Port 80 and 443 must be reachable from the internet for the ACME challenge.

**nginx** (if you already run nginx):

```sh
sudo cp deploy/nginx.example.conf /etc/nginx/sites-available/atlas
sudo $EDITOR /etc/nginx/sites-available/atlas    # replace atlas.example.com, paths, cert paths
sudo ln -s /etc/nginx/sites-available/atlas /etc/nginx/sites-enabled/atlas
sudo nginx -t && sudo systemctl reload nginx
```

You provision the cert yourself (certbot, acme.sh). nginx's example also includes a `/api/login` rate limit at the proxy layer.

Either way, the API has its own internal rate limit on login, so the proxy-side limit is defense in depth.

### macOS (launchd)

Same shape, but use `deploy/atlas-api.plist` (template; replace `/Users/YOU/atlas`). launchd does not have systemd-style socket activation, so set `idle_exit_seconds: 0` in `tools/config.json` so the process stays up.

## First sign-in

Open the site. If you didn't pre-seed `initial_user` and `initial_password`, register the first account; that user becomes the operator and registration auto-closes after that. From the menu, "Settings" lets you toggle visible features, pick a default tile layer, switch units, customize appearance (theme, mode, pin style, marker size, trail thickness, tile filter), publish your map at `/u/<your-username>/`, download a zip export of your data, change your password, manage active sessions, and (as operator) edit category labels or re-open registration to invite someone.

If you set `require_setup_token: true` in the API config, the first registration also needs the one-time token printed to the API log on startup. Recommended when deploying to the open internet. See [SECURITY.md](../SECURITY.md).

## Updating

```sh
cd /path/to/source
git pull
sudo ./deploy/install.sh --yes
sudo systemctl restart atlas-api.service
```

The installer never overwrites operator config (`tools/config.json`, `site-config.json`) or data (`users/`, `tools/atlas.db`). Only application files and the systemd units are replaced.
