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

The browser tests start their own throwaway server with the demo dataset, so they need none of the above. They need Node 20 or newer and one install of Playwright and its browsers:

```sh
npm ci
npx playwright install
npx playwright test
```

They run in Firefox and Chromium at 1280px, Chromium with Pixel emulation and WebKit with iPhone emulation (`playwright.config.js`), with tiles stubbed so nothing leaves the machine. `npx playwright test --project=chromium` runs one. Playwright is pinned to the release the CI image carries, so bump `package.json` and that image together.

They cover the flows a test plan used to check by hand: signing in and out, adding a place and finding it in the list and on the map, editing and deleting it, importing a GPX route and its elevation graph, the map's filter panel and a list's "Clear filters", a settings radio and the theme surviving a reload, picking a place's position on the map from the Add and Edit dialogs, changing the password, revoking one session or all the others, Esc closing a modal and handing focus back, and on the phone projects the bottom bar and a modal's phone layout at 320px and 412px. A test that only reads signs in as the demo account; one that writes signs up an empty account of its own (`tests/e2e/helpers.js`), because the projects run at once against one server. A change to one of these flows updates its test in the same PR.

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

CI also type-checks `app/` with TypeScript reading the JSDoc, in full strict mode plus `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noImplicitReturns` and `exactOptionalPropertyTypes` (`tsconfig.json`). Nothing ships compiled; TypeScript is fetched in CI only. Errors are held to `types/tsc-baseline.txt`, which is empty, and CI fails when the list changes either way. A TypeScript bump that adds a flag to `strict` records the errors it raises there in the same commit, and a fix lowers it the same way. To run it locally:

```sh
npx -p typescript@5.9.3 tsc -p . --pretty false > /tmp/tsc.out
python3 scripts/typecheck.py /tmp/tsc.out            # add --update after fixing errors
```

Type API responses and shared state with JSDoc `@typedef` where they are defined (`AuthState` in `app/core.js` is the pattern). Globals from the classic scripts and the Android bridge are declared in `types/globals.d.ts`. `tests/test_api_contract.py` holds each JSON response to the typedef the client reads it as, so a new endpoint whose body the client reads adds a row to `ENDPOINTS` in `tests/api_contract.py` (one it ignores goes in `NOT_READ`), and a handler key added or renamed fails until its typedef follows.

Stdlib only, no deps. Two layers: unit tests for pure helpers and file utilities in `tools/ferd_api/`, and integration tests that launch the API in a subprocess and hit endpoints over HTTP. Run before opening a PR. If your change touches the API surface or one of the helpers, add a case.

### Modal review sheet

`.site-sheet/states.json` lists every modal and the clicks that open it, for the `site-sheet` tool, which shoots each one in light and dark at phone and desktop width with an axe run. `.site-sheet/serve.py` starts the API on loopback with a demo admin (`demo` / `demo-password-1`) and the places, area, route and catalog update the states open. To see the sheet locally:

```sh
python3 .site-sheet/serve.py 8097 &
site-sheet capture "" / /tmp/ferd-sheet --states .site-sheet/states.json --origin http://127.0.0.1:8097
```

A new modal needs a state here; `tests/test_site_sheet.py` fails on a modal title no state waits for.

The browser tests stand in for the old by-hand walk through the app, so a PR's test plan names them rather than repeating it. It keeps a "works on the preview" check only for a visual change, where a passing test does not show that it looks right.

## Reporting issues

Open a GitHub issue with: what you did, what happened, what you expected, and the API server log if relevant. If it's a security issue, please email instead of filing publicly.
