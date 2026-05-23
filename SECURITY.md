# Security

Ferd is a self-hosted single-instance app. The threat model assumes the admin controls the box and the network gate (nginx + TLS, or a VPN). This page documents what the app does to harden itself within that assumption, and where the admin still has to think.

## First-run window

Before the first user registers, registration is open. If the site is reachable from the public internet during the window between deploy and first registration, a stranger can race you to claim the admin account. Close the window via VPN-only access during setup, a pre-seeded admin, or a setup token; see [install.md > First-run hardening](docs/install.md#first-run-hardening) (or [docker.md > Configuration](docs/docker.md#configuration) for the container path).

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

See [install.md > Backups](docs/install.md#backups) (bare-metal) or [docker.md > Backups](docs/docker.md#backups) (container) for recipes. The two paths that matter are `users/` (everyone's data) and `tools/app.db*` (auth state plus site-wide settings).
