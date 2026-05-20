# Changelog

All notable changes to Atlas are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it tags a `0.1.0` release.

Until then, every change lands under `[Unreleased]` and `main` is the only branch.

## [Unreleased]

### Added

- Per-trail metadata editor in the UI. Trail popups and the trail detail page expose an Edit button that opens a modal with: date hiked, rating (1-5), notes (up to 2000 chars), tags (up to 10, lowercase), difficulty (easy / moderate / hard / expert), and source URL. Backed by `PUT /api/metadata` keyed on `Region/Trail name`; the manifest regenerates so `routes.json` picks up changes immediately.
- Click-to-filter on list views. Clicking a region header in the trails list (or a category header in the places list) jumps to the map showing only that region's trails (or that category's places). Other axis is hidden; user re-enables from the filter panel.
- Region chips in the trails filter panel, matching the existing category chips for places. The Trails toggle-all now mirrors Places: clears region hides and resets completed/planned together.
- `bbox` field per route in `routes.json` (computed from GPX trkpts during `gpx-manifest.sh`). Used to fit the map to a filtered region without waiting on async GPX loads.
- Trail title in popups is now a link to the trail detail page. Replaces the standalone "View details" row.
- Trail Delete moved into the Edit modal (matching the place Edit modal pattern) and added to the trail detail page; removed from the popup to reduce misclick risk on the small marker bubble.
- Per-user maps. Each user owns an isolated `users/<username>/` folder (places, routes, GPX, prefs, metadata). Any authenticated user can write to their own folder; the operator role no longer gates writes.
- Per-user "publish my map" toggle in Settings. With it on, anyone can read the user's map at `/u/<username>/`; with it off, all read endpoints under `/api/u/<username>/...` return 404.
- Per-user zip export from Settings.
- Per-user zip import from Settings (Backup section), with replace and merge modes. Imports go through `POST /api/me/import` (50 MB cap, zip-slip guard, GPX PII stripping; regenerates the trail manifest).
- "Sign out other sessions" button inline with the Active sessions header, backed by `POST /api/sessions/revoke-others`. Hidden when only the current session exists.
- `docs/design.md` documenting the modal/button/feedback conventions used across the frontend.
- New API endpoints: `GET /api/places`, `GET /api/routes`, `GET /api/metadata`, `GET /api/gpx/<region>/<file>`, `GET/PUT /api/me/prefs`, `POST /api/me/publish`, `GET /api/me/export`, `POST /api/me/import`, `POST /api/sessions/revoke-others`, and the public counterparts `GET /api/u/<username>/{places,routes,metadata,gpx/<region>/<file>}`.
- One-shot startup migration: pre-existing `places.json`, `routes.json`, `metadata.json`, and `gpx/` at the `data_dir` root are moved into the first operator's `users/<operator>/` folder.

### Changed

- The frontend no longer reads `places.json` / `routes.json` / `metadata.json` as static files; all data is fetched through the API. Unauthenticated visits to `/` now show a sign-in landing instead of an empty map.
- `/u/<username>/` paths are rewritten to `index.html`; the SPA detects the URL and renders a read-only public view of that user's published map.
- `gpx-manifest.sh` accepts a target directory as `$1` and is invoked once per user with `cwd=users/<username>/`. Relative `manifest_cmd` paths are resolved against `data_dir`.
- Avoid full map re-render on place CRUD. Add/edit/delete now reconcile place markers in place (and refresh the cluster + filter panel) instead of calling the router and rebuilding all Leaflet layers.
- Settings modal moved to a tabbed layout (General / Appearance / Account / Admin). Admin-only Categories and Registration are on their own tab; the Account tab consolidates Sharing, Backup, Password, and Active sessions. The bottom "Close" button was removed in favor of the corner X (Esc still closes).
- Password change feedback moved from a transient button label to an explicit success line. Export now uses a fetch+blob download so server errors surface inside the modal instead of a broken browser download.

### Removed

- The "static only" install tier. The frontend now requires the API for every data read.

### Fixed

- URL-decode path segments in `/api/gpx/<region>/<file>` and `/api/u/<username>/gpx/...` before resolving them on disk. GPX files with accented or spaced names (`Himakånå.gpx`, `Mahmutlar - Kargicak.gpx`) returned 404 because the percent-encoded URL string was being treated as the literal filename.

### Security

- (none yet)
