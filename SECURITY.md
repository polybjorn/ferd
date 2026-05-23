# Security

Atlas is a self-hosted single-instance app. The threat model assumes the admin controls the box and the network gate (nginx + TLS, or a VPN). This page documents what the app does to harden itself within that assumption, and where the admin still has to think.

## First-run window

Before the first user registers, registration is open. If the site is reachable from the open internet during the window between deploy and first registration, a stranger can race you to claim the admin account.

Three ways to close the window:

1. **Don't expose the site to the public internet until you've registered.** Easiest for private deploys behind a VPN or LAN.
2. **Pre-seed the admin account.** Set `initial_user` and `initial_password` in `tools/config.json`. On first start with no users, the account is created and registration is already closed by the time the API accepts its first request.
3. **Require a setup token.** Set `require_setup_token: true`. On first start the API generates a random token and prints it to stderr. Registration is open but the first registration must supply the token. The token is consumed once the first account exists.

## Account model

- Username/password, hashed with PBKDF2-SHA256 at 600k iterations (OWASP 2024+ guidance for PBKDF2-SHA256), 16-byte salt, 32-byte derived key.
- Usernames are case-insensitive via `COLLATE NOCASE`. Valid characters: alphanumerics, hyphens, underscores. Max 64 chars.
- Passwords must be 12 to 256 characters. The upper bound prevents PBKDF2 DoS via huge inputs.
- The first registered user is marked admin. Admin-only endpoints today: re-opening registration, editing `site-config.json` category labels. Every other account has the same powers within its own `users/<username>/` folder; the admin cannot read or modify other users' data.
- Registration auto-closes after the first user. The admin can re-open it from Settings to invite someone.

## Sessions

- Cookie-based. `HttpOnly`, `SameSite=Lax`, `Secure` when `secure_cookies` is true.
- 30-day expiry. Stored in SQLite so they survive a process restart (important for socket-activated deploys).
- Listed under Settings → Active sessions. Each entry shows the device, IP, and last seen time. The current device is marked. Other sessions can be revoked.
- Changing your password invalidates every session except the one initiating the change.

## Login hardening

- Per-IP rate limit: 10 failed attempts per 15 minutes triggers `429`. Counter resets on a successful login.
- Username enumeration via response time is blocked: when the username doesn't exist, the API runs a dummy PBKDF2 round to equalize timing.
- The nginx example also rate-limits `/api/login` at the proxy layer (defense in depth).

## Write endpoints

- All writes require an authenticated session. Writes land in the calling user's `users/<username>/` folder; nothing in the API lets one user write to another user's data. Read endpoints follow the same scope, plus an explicit public read path (`/api/u/<username>/...`) that returns 404 unless that user's `published` flag is on.
- Place writes go through schema validation: required/optional field names checked, lat in `[-90, 90]`, lon in `[-180, 180]`, string length caps. Unknown fields rejected with 400.
- `sources` entries are restricted to `http://` or `https://` URLs. Other schemes (`javascript:`, `data:`, `mailto:`, ...) are rejected at the API. The frontend re-checks the protocol when rendering source links and falls back to inert text if it isn't http(s), so legacy data from before this check can't be turned into a clickable script URL.
- Writes are atomic: tmp file in the target directory, fsync, `os.replace`, fsync directory. Symlinks are resolved so writes land on the real file and the link stays intact.
- A file lock (`fcntl.flock`) serializes concurrent writes to `places.json` and the `gpx/` tree within each user's folder.
- GPX uploads are XML-parsed before saving; non-GPX content is rejected. PII is stripped server-side: `<time>` and `<author>` elements removed, `creator=` attribute on `<gpx>` dropped. Never trusts client-side stripping.
- GPX region and filename are validated against a strict character set, normalized, and confirmed to resolve inside the user's `gpx/` root. The public read path applies the same validation to the username and path components before resolving.

## What's served by the dev `static_dir`

The integrated dev mode serves files from `static_dir`. The handler refuses any path containing `..`, any URL-decoded NUL byte, and any path whose first segment is `tools/`, `deploy/`, or `.git/`. Paths under `/u/<username>/` are rewritten to `index.html` so the SPA can pick up the per-user public view; the actual per-user content is reachable only through the API. Symlinks within `static_dir` are allowed and intentionally not resolved, so symlinks pointing into your data store work.

In production, nginx serves the static content directly. The example config in `deploy/nginx.example.conf` has matching `deny` rules for the sensitive paths.

## SQLite

`tools/app.db` holds password hashes and active session tokens. Created 0600. WAL and SHM siblings created at the same permissions.

Backup includes this file. The whole users + sessions state lives in three files: `tools/app.db`, `tools/app.db-shm`, `tools/app.db-wal`. Use any backup tool that handles SQLite (or stop the service before snapshotting).

## What the app does not protect against

- A malicious admin. The model is "single-user, trusted admin".
- A compromise of the box. Anything on the host can read the DB and the data files.
- A network attacker between you and the site if you skip TLS. Always front it with HTTPS in production.
- Cross-site request forgery on browsers older than 2020 that ignore `SameSite=Lax`. The modern major browsers respect it; we don't carry a CSRF token.

## Backups

Two paths matter:

- `users/` (everyone's places, trails, and prefs; symlinks within are followed at write time)
- `tools/app.db*` (users, sessions, publish flags, site-wide settings)

Lose the first and you lose data. Lose the second and you have to register a new account but your data survives. Each user can also download a per-user zip export from Settings.

---

## Smoke tests

These are the curl sequences used during development. Useful when reviewing a change to auth or write endpoints.

### Auth API sanity

```sh
# Fresh server (no users yet)
curl -s http://127.0.0.1:8090/api/state
# expect: {"authenticated": false, "registration_open": true, "has_users": false, ...}

# Register
curl -s -c /tmp/c -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"correcthorsebattery"}' \
  http://127.0.0.1:8090/api/register

# 2nd register denied (auto-closed)
curl -s -H 'Content-Type: application/json' \
  -d '{"username":"other","password":"correcthorsebattery"}' \
  http://127.0.0.1:8090/api/register
# expect: {"error":"registration is closed"}

# Sign out, then bad and good logins
curl -s -b /tmp/c -X POST http://127.0.0.1:8090/api/logout
curl -s -H 'Content-Type: application/json' -d '{"username":"alice","password":"wrong"}' http://127.0.0.1:8090/api/login
curl -s -c /tmp/c -H 'Content-Type: application/json' -d '{"username":"alice","password":"correcthorsebattery"}' http://127.0.0.1:8090/api/login
```

### Write API sanity

```sh
# Add a place
curl -s -b /tmp/c -H 'Content-Type: application/json' \
  -d '{"name":"Smoke","lat":1,"lon":2,"category":"nature"}' \
  -X POST http://127.0.0.1:8090/api/places

# Edit it
curl -s -b /tmp/c -H 'Content-Type: application/json' \
  -d '{"original_name":"Smoke","place":{"name":"Smoke2","lat":3,"lon":4,"category":"nature"}}' \
  -X PUT http://127.0.0.1:8090/api/places

# Delete it
curl -s -b /tmp/c -H 'Content-Type: application/json' -d '{"name":"Smoke2"}' \
  -X DELETE http://127.0.0.1:8090/api/places

# Upload a tiny valid GPX
cat > /tmp/t.gpx <<'X'
<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1">
  <trk><name>T</name><trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg></trk>
</gpx>
X
curl -s -b /tmp/c -X POST --data-binary @/tmp/t.gpx \
  'http://127.0.0.1:8090/api/gpx?region=SmokeTest&name=T'

# Delete it
curl -s -b /tmp/c -H 'Content-Type: application/json' \
  -d '{"region":"SmokeTest","name":"T"}' -X DELETE http://127.0.0.1:8090/api/gpx
```
