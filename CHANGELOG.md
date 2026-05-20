# Changelog

All notable changes to Atlas are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it tags a `0.1.0` release.

Until then, every change lands under `[Unreleased]` and `main` is the only branch.

## [Unreleased]

### Added

- Per-user maps. Each user owns an isolated `users/<username>/` folder (places, routes, GPX, prefs, metadata). Any authenticated user can write to their own folder; the operator role no longer gates writes.
- Per-user "publish my map" toggle in Settings. With it on, anyone can read the user's map at `/u/<username>/`; with it off, all read endpoints under `/api/u/<username>/...` return 404.
- Per-user zip export from Settings.
- New API endpoints: `GET /api/places`, `GET /api/routes`, `GET /api/metadata`, `GET /api/gpx/<region>/<file>`, `GET/PUT /api/me/prefs`, `POST /api/me/publish`, `GET /api/me/export`, and the public counterparts `GET /api/u/<username>/{places,routes,metadata,gpx/<region>/<file>}`.
- One-shot startup migration: pre-existing `places.json`, `routes.json`, `metadata.json`, and `gpx/` at the `data_dir` root are moved into the first operator's `users/<operator>/` folder.

### Changed

- The frontend no longer reads `places.json` / `routes.json` / `metadata.json` as static files; all data is fetched through the API. Unauthenticated visits to `/` now show a sign-in landing instead of an empty map.
- `/u/<username>/` paths are rewritten to `index.html`; the SPA detects the URL and renders a read-only public view of that user's published map.
- `gpx-manifest.sh` accepts a target directory as `$1` and is invoked once per user with `cwd=users/<username>/`. Relative `manifest_cmd` paths are resolved against `data_dir`.
- Avoid full map re-render on place CRUD. Add/edit/delete now reconcile place markers in place (and refresh the cluster + filter panel) instead of calling the router and rebuilding all Leaflet layers.

### Removed

- The "static only" install tier. The frontend now requires the API for every data read.

### Fixed

- (none yet)

### Security

- (none yet)
