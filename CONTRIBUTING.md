# Contributing

Thanks for considering a contribution. Atlas is a small project; the bar for changes is "fits the existing shape and doesn't break the smoke tests".

## Run it locally

The API can also serve the static files, so one Python process is the whole stack for development.

```sh
cp tools/config.example.json tools/config.json
cp site-config.example.json site-config.json

ATLAS_DATA_DIR="$PWD" \
ATLAS_STATIC_DIR="$PWD" \
ATLAS_MANIFEST_CMD="$PWD/gpx-manifest.sh" \
ATLAS_SECURE_COOKIES=false \
ATLAS_BIND=127.0.0.1:8090 \
  python3 tools/api.py
```

Open `http://127.0.0.1:8090/`. Click "Sign in", register the first account, then use the "+" button on the map. `secure_cookies=false` is required for plain HTTP. Do not expose this server to the network; it bypasses the production hardening assumptions.

To start completely fresh, delete `tools/atlas.db*`. Any data you added through the API lives in `places.json` and `gpx/`, which are gitignored.

## Repository layout

```
index.html               # the app (HTML/CSS/JS in one file)
site-config.example.json # branding, default view, category labels, API base
gpx-manifest.sh          # generates routes.json from gpx/<Region>/<Trail>.gpx
tools/
  api.py                 # stdlib-only API server (auth + write endpoints)
  config.example.json    # API config template
deploy/
  atlas-api.socket       # systemd socket unit
  atlas-api.service      # systemd service unit
  atlas-api.plist        # macOS launchd template
  nginx.example.conf     # nginx server block
docs/
  configure.md           # config field reference
  install.md             # install walk-through
  themes.md              # theme system + how to add one
SECURITY.md              # account model, setup token, threat notes
```

The repo intentionally has no build step, no JS framework, no bundler. Edits to `index.html` show up on reload.

## Tests

Tests live in `tests/`. Run from the repo root:

```sh
python3 -m unittest discover -s tests
```

Stdlib only, no deps. Two layers: unit tests for pure helpers and file utilities in `tools/api.py`, and integration tests that launch the API in a subprocess and hit endpoints over HTTP. Run before opening a PR. If your change touches the API surface or one of the helpers, add a case.

The PRs I review against locally also walk through the curl sequences in the [phase 1](SECURITY.md#auth-api-sanity) and [phase 2](SECURITY.md#write-api-sanity) sections of the security doc, plus the UI flows below.

## UI smoke walk

To verify the static side end to end, run the dev server above, sign in, and do all of: add a place from the map ("Pick on map" then form), edit a place from its popup, delete a place, upload a GPX, delete a trail, switch themes, change your password, revoke a session.

## Code style

- 2-space indentation, JavaScript and Python alike.
- No frameworks. Vanilla JS for the frontend, stdlib only for the API.
- Comments only where the why is non-obvious. Don't document what the next line literally does.
- Match the existing nesting and naming. The frontend uses lowercase camelCase functions; the API uses `_h_` prefixed handler methods and snake_case helpers.
- Don't pull in dependencies for things that can be done in fifty lines of stdlib.

## Reporting issues

Open a GitHub issue with: what you did, what happened, what you expected, and the API server log if relevant. If it's a security issue, please email instead of filing publicly.
