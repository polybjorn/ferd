# Contributing

Thanks for considering a contribution. This is a small project; the bar for changes is "fits the existing shape and doesn't break the smoke tests".

## Run it locally

Follow the [Install](docs/python.md#install) section in python.md, with two dev tweaks: bind `127.0.0.1:8090` (loopback only - do not expose the dev server) and skip the seeded admin so you can exercise the register flow. Env-var one-liner if you'd rather not edit `tools/config.json`:

```sh
cp site-config.example.json site-config.json
FERD_DATA_DIR="$PWD" FERD_STATIC_DIR="$PWD" \
FERD_MANIFEST_CMD="$PWD/gpx-manifest.sh" \
FERD_SECURE_COOKIES=false FERD_BIND=127.0.0.1:8090 \
  python3 tools/api.py
```

To start completely fresh, delete `tools/app.db*` and `users/` (both gitignored).

Edits to `index.html` show up on reload.

## Where to look

This page covers the workflow (run, test, submit). The deeper material lives in topic-specific docs:

- [docs/architecture.md](docs/architecture.md) - repo layout, data flow, stack rules, and code style.
- [docs/design.md](docs/design.md) - UI conventions: modal anatomy, button placement, status feedback, copy style. Read this before adding or changing anything in `index.html`.
- [docs/themes.md](docs/themes.md) - "For contributors" half covers the CSS variable contract and how to add a theme.
- [docs/api.md](docs/api.md) - every `/api/*` endpoint, plus smoke recipes for manually verifying auth and write changes.
- [docs/catalog.md](docs/catalog.md) - the site catalog, including how to add a place to the shipped baseline.

## Tests

Tests live in `tests/`. Run from the repo root:

```sh
python3 -m unittest discover -s tests
```

Stdlib only, no deps. Two layers: unit tests for pure helpers and file utilities in `tools/api.py`, and integration tests that launch the API in a subprocess and hit endpoints over HTTP. Run before opening a PR. If your change touches the API surface or one of the helpers, add a case.

To verify the static side end to end, run the dev server above, sign in, and do all of: add a place from the map ("Pick on map" then form), edit a place from its popup, delete a place, upload a GPX, delete a trail, switch themes, change your password, revoke a session.

## Reporting issues

Open a GitHub issue with: what you did, what happened, what you expected, and the API server log if relevant. If it's a security issue, please email instead of filing publicly.
