# Changelog

All notable changes to Ferd are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Shipped catalog: 27 new entries.
- `GET /api/health` for liveness checks; returns `{status: "ok", version}`.
- Install docs and installer output now point at the source clone as the place to re-run `install.sh` from on updates.

### Fixed
- Backup import now silently skips archiver junk entries (`__MACOSX/`, `._*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.bak`, `*~`) instead of rejecting the whole zip. Zips made by macOS Finder, Windows Explorer, and editor backups now import without manual cleanup.
- Install docs: python.md LAN-bind port corrected from 8090 to 8091.

### Security
- API handlers that touch the filesystem now verify the resolved path stays under the expected directory. The static handler also catches symlink escapes that the prior lexical check could not see.
- GPX uploads reject DOCTYPE and entity declarations, blocking XML-bomb expansion (uploads remain admin-only).
- Place and trail list rows escape backslashes when building inline click handlers.
- The tests workflow runs with explicit read-only token permissions.

## [1.0.0] - 2026-05-25

Initial release. Ferd is a self-hosted Leaflet map for travel places and GPX routes: a single-file static frontend served alongside a stdlib-only Python API. Per-user data isolation, in-browser editing, optional public read-only sharing at `/u/<username>/`, themed UI, and zip import/export. Two install paths: bare-metal (systemd / launchd + reverse proxy) or Docker Compose.
