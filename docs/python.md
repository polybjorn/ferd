# Running with Python

Requires Python 3.11+. No build step, no Node, no `pip install`.

If you'd rather run in a container, see [docker.md](docker.md).

## Install

```sh
git clone https://github.com/polybjorn/ferd.git
cd ferd
cp tools/config.example.json tools/config.json
python3 tools/api.py
```

Open http://localhost:8091 and register the first account; that user becomes the admin. The defaults in `tools/config.json` bind to loopback and store data in the current directory. Most app configuration (appearance, publishing, sessions, admin tools) lives in the in-browser Settings dialog.

To reach the site from other devices on your network, change `bind` to `0.0.0.0:8091` and set `secure_cookies: false` (required when there's no HTTPS in front).

## Footprint

About 1.7 MB of code and assets. Python uses about 32 MB of memory at idle.

## Run it as a service

For "always on" without keeping a terminal open, use your usual process manager (systemd `--user`, supervisord, a tmux session). On a Linux server with systemd available system-wide, the repo ships a guided installer that lays files at `/srv/ferd`, creates a `ferd` user, and installs socket-activated units:

```sh
sudo ./deploy/install.sh --yes
```

Audit the script first if you like (`less deploy/install.sh`); it's a couple of hundred lines of `cp`, `useradd`, and `systemctl`.

Keep the source clone somewhere stable (e.g. `/opt/ferd-src` or `~/src/ferd`). The installer copies files into `/srv/ferd` but never touches the source; you re-run it from the same clone on every update.

### macOS (launchd)

Edit the `/Users/YOU/ferd` paths in `deploy/ferd-api.plist`, then load it as a per-user agent:

```sh
cp deploy/ferd-api.plist ~/Library/LaunchAgents/local.ferd-api.plist
launchctl load ~/Library/LaunchAgents/local.ferd-api.plist
```

Logs land at `tools/ferd-api.log`. Reload with `launchctl unload` then `launchctl load`. Drop the plist into `/Library/LaunchDaemons/` instead for a system-wide service (runs without your login session).

See [configure.md](configure.md) for every config knob.

## Exposing it on a public domain

Front it with any reverse proxy for TLS and a clean hostname. Sample configs for the two common ones live in [`deploy/Caddyfile.example`](../deploy/Caddyfile.example) (recommended; automatic Let's Encrypt) and [`deploy/nginx.example.conf`](../deploy/nginx.example.conf) (bring your own cert).

Once HTTPS is in front, set `secure_cookies: true`. The proxy forwards to the API's bind address (loopback by default).

## First-run hardening

Between starting the API and registering the first account, registration is open. If the site is reachable from the public internet during that window, a stranger can race you to claim the admin account. Three ways to close it; pick one:

1. **Don't expose the site to the internet until you've registered.** Trivial for private deploys behind a VPN or LAN.
2. **Pre-seed the admin account.** Set `initial_user` and `initial_password` in `tools/config.json`. The account is created on first start and registration is already closed by the time the API accepts its first request.
3. **Require a setup token.** Set `require_setup_token: true`. The API generates a random token at startup and prints it to stderr; the first registration must supply it. If the user table empties while the API runs (a wipe, or a restore from an empty backup), the next registration attempt is refused and prints a fresh token the same way.

## Updating

```sh
cd /path/to/source
git pull
sudo ./deploy/install.sh --yes        # if you used the guided installer
sudo systemctl restart ferd-api.service
curl -fs http://127.0.0.1:8091/api/health   # smoke check; prints {"status":"ok",...}
```

Your config and data are never touched. If you deleted the source clone after install, just clone it again anywhere and run `install.sh` from there.

## Backups

Two paths matter:

- `tools/app.db*` (users, sessions, publish flags, site-wide settings, and every user's places, areas, route metadata, prefs and category labels - SQLite database plus its `-shm` and `-wal` siblings)
- `users/` (uploaded GPX files, plus the JSON files from before the SQLite store, which are only a stale copy)

Lose `app.db` and you lose accounts and places. Lose `users/` and you lose the GPX files.

Copy `app.db` only with the service stopped or with SQLite's `.backup`. A plain `cp` or `rsync` of a running database can capture the main file without the `-wal` changes, or half of a write.

Simplest recipe: stop the service and tar the lot.

```sh
sudo systemctl stop ferd-api.service
sudo tar -czf ferd-$(date +%F).tar.gz -C /srv/ferd users tools/app.db tools/app.db-shm tools/app.db-wal 2>/dev/null
sudo systemctl start ferd-api.service
```

For an online backup without stopping the service, use SQLite's `.backup` for the DB and `rsync` for `users/` (take the DB first, so it never refers to a GPX file the copy lacks):

```sh
sudo -u ferd python3 -c "import sqlite3; sqlite3.connect('/srv/ferd/tools/app.db').backup(sqlite3.connect('/srv/ferd/tools/app.db.bak'))"
sudo rsync -a /srv/ferd/users/ /backup/ferd-users/
```

After restoring `app.db` from a backup, rotate the sync epoch so clients that kept their own copy fetch everything again instead of trusting a revision number that went backwards or stayed behind:

```sh
sudo -u ferd sqlite3 /srv/ferd/tools/app.db "UPDATE store_revs SET epoch = lower(hex(randomblob(8)))"
```

Each signed-in user can also download a per-user zip export from Settings.

## A user's data will not load

Startup moves each user's JSON files into `app.db` once. If a file cannot be read (not valid JSON, not UTF-8, the wrong shape, or the user folder is missing), that user is skipped and the log says which: `startup work for <name> skipped: ... <name>/<file>: <reason>`. Every request for that user then answers `500 user data not migrated: <name>/<file>: <reason>`, while other users are unaffected. Nothing is half-migrated. Fix the file, or move it out of the folder, then restart the service. A missing user folder means `data_dir` points to the wrong place or the restore lost `users/`.

If the log warns that a JSON file changed after the user was migrated, an older version ran against this data and its edits are not in `app.db`. Export from that version and import here.
