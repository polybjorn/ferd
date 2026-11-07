# Contributing

Thanks for considering a contribution. This is a small project; the bar for changes is "fits the existing shape and doesn't break the smoke tests".

## Run it locally

Follow the [Install](docs/python.md#install) section in python.md, with two dev tweaks: bind `127.0.0.1:8090` (loopback only - do not expose the dev server) and skip the seeded admin so you can exercise the register flow. Env-var one-liner if you'd rather not edit `tools/config.json`:

```sh
cp site-config.example.json site-config.json
FERD_DATA_DIR="$PWD" FERD_STATIC_DIR="$PWD" \
FERD_MANIFEST_CMD="$PWD/scripts/gpx-manifest.sh" \
FERD_SECURE_COOKIES=false FERD_BIND=127.0.0.1:8090 \
  python3 tools/api.py
```

To start completely fresh, delete `tools/app.db*` and `users/` (both gitignored).

Edits to `index.html` and `app/` show up on reload.

## Where to look

This page covers the workflow (run, test, submit). The deeper material lives in topic-specific docs:

- [docs/architecture.md](docs/architecture.md) - repo layout, data flow, stack rules, platform targets, and code style.
- [docs/themes.md](docs/themes.md) - "For contributors" half covers the CSS variable contract and how to add a theme.
- [docs/api.md](docs/api.md) - every `/api/*` endpoint, plus smoke sequences for manually verifying auth and write changes.
- [docs/catalog.md](docs/catalog.md) - the site catalog, including how to add a place to the shipped baseline.

## Tests

Tests live in `tests/`. Run from the repo root:

```sh
python3 -m unittest discover -s tests
```

The frontend has its own tests, among them the on-device store and its sync queue in `app/store.js`, run with Node 20 or newer and no install step:

```sh
node --test tests/js/*.test.js
```

CI also type-checks `app/` with TypeScript reading the JSDoc (`tsconfig.json`, `strict` off). Nothing ships compiled; TypeScript is fetched in CI only. The errors that predate the check are listed in `types/tsc-baseline.txt`, and CI fails when the list changes either way, so a fix lowers it in the same commit. To run it locally:

```sh
npx -p typescript@5.9.3 tsc -p . --pretty false > /tmp/tsc.out
python3 scripts/typecheck.py /tmp/tsc.out            # add --update after fixing errors
```

A second run turns the strict flags on one at a time. `tsconfig.strict.json` extends `tsconfig.json` with the flags staged so far (`noImplicitAny` first, then `strictNullChecks`, then `strict`), and its errors are held to `types/tsc-strict-baseline.txt` the same way. The next flag goes on once this baseline is empty.

```sh
npx -p typescript@5.9.3 tsc -p tsconfig.strict.json --pretty false > /tmp/tsc-strict.out
python3 scripts/typecheck.py /tmp/tsc-strict.out --baseline types/tsc-strict-baseline.txt
```

Type API responses and shared state with JSDoc `@typedef` where they are defined (`AuthState` in `app/core.js` is the pattern). Globals from the classic scripts and the Android bridge are declared in `types/globals.d.ts`.

Stdlib only, no deps. Two layers: unit tests for pure helpers and file utilities in `tools/ferd_api/`, and integration tests that launch the API in a subprocess and hit endpoints over HTTP. Run before opening a PR. If your change touches the API surface or one of the helpers, add a case.

### Modal review sheet

`.site-sheet/states.json` lists every modal and the clicks that open it, for the `site-sheet` tool, which shoots each one in light and dark at phone and desktop width with an axe run. `.site-sheet/serve.py` starts the API on loopback with a demo admin (`demo` / `demo-password-1`) and the places, area, route and catalog update the states open. To see the sheet locally:

```sh
python3 .site-sheet/serve.py 8097 &
site-sheet capture "" / /tmp/ferd-sheet --states .site-sheet/states.json --origin http://127.0.0.1:8097
```

A new modal needs a state here; `tests/test_site_sheet.py` fails on a modal title no state waits for.

To verify the static side end to end, run the dev server above, sign in, and do all of: add a place from the map ("Pick on map" then form), edit a place from its popup, delete a place, upload a GPX, delete a route, switch themes, change your password, revoke a session.

## Reporting issues

Open a GitHub issue with: what you did, what happened, what you expected, and the API server log if relevant. If it's a security issue, please email instead of filing publicly.
