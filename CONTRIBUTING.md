# Contributing

Thanks for considering a contribution. This is a small project; the bar for changes is "fits the existing shape and doesn't break the smoke tests".

## Run it locally

The API can also serve the static files, so one Python process is the whole stack for development.

```sh
cp tools/config.example.json tools/config.json
cp site-config.example.json site-config.json

FERD_DATA_DIR="$PWD" \
FERD_STATIC_DIR="$PWD" \
FERD_MANIFEST_CMD="$PWD/gpx-manifest.sh" \
FERD_SECURE_COOKIES=false \
FERD_BIND=127.0.0.1:8090 \
  python3 tools/api.py
```

Open `http://127.0.0.1:8090/`. Click "Sign in", register the first account, then use the "+" button on the map. `secure_cookies=false` is required for plain HTTP. Do not expose this server to the network; it bypasses the production hardening assumptions.

To start completely fresh, delete `tools/app.db*` and `users/`. Per-user data (places, trails, prefs) lives under `users/<username>/`, which is gitignored.

## How it fits together

For repo layout, data flow, and the design rules (no build step, stdlib only, no framework), see [docs/architecture.md](docs/architecture.md). Edits to `index.html` show up on reload.

## Tests

Tests live in `tests/`. Run from the repo root:

```sh
python3 -m unittest discover -s tests
```

Stdlib only, no deps. Two layers: unit tests for pure helpers and file utilities in `tools/api.py`, and integration tests that launch the API in a subprocess and hit endpoints over HTTP. Run before opening a PR. If your change touches the API surface or one of the helpers, add a case.

The PRs I review against locally walk through the smoke sequences below.

## Smoke tests

Run against the local dev server above. Useful when reviewing a change to auth or write endpoints; see [docs/api.md](docs/api.md) for the full endpoint reference.

### Auth API

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

### Write API

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

### UI

To verify the static side end to end, run the dev server above, sign in, and do all of: add a place from the map ("Pick on map" then form), edit a place from its popup, delete a place, upload a GPX, delete a trail, switch themes, change your password, revoke a session.

## Code style

- 2-space indentation, JavaScript and Python alike.
- Comments only where the why is non-obvious. Don't document what the next line literally does.
- Match the existing nesting and naming. The frontend uses lowercase camelCase functions; the API uses `_h_` prefixed handler methods and snake_case helpers.
- Stack rules (no frameworks, stdlib only, no deps for things under fifty lines) are in [docs/architecture.md > Why no build step](docs/architecture.md#why-no-build-step).

## Reporting issues

Open a GitHub issue with: what you did, what happened, what you expected, and the API server log if relevant. If it's a security issue, please email instead of filing publicly.
