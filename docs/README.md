# Documentation

## Install and run

- [Python](python.md) - bare Python 3.9+, no build step. Covers local use, LAN, and service install (systemd, launchd).
- [Docker](docker.md) - tag tracks, `compose.yml`, reverse proxy, updates.
- [PWA](pwa.md) - install on phone, what works offline, cache and update behavior.

## Use and customize

- [Configuration](configure.md) - the two config files (`site-config.json`, `tools/config.json`) and what each setting does.
- [Themes](themes.md) - bundled themes, light/dark/system mode, and how to add your own.
- [Catalog](catalog.md) - the shared list of places users can browse and import; how the shipped baseline merges with admin additions.

## Develop

- [API](api.md) - reference for every `/api/*` endpoint, for scripts and integrations.
- [Architecture](architecture.md) - one-page tour of the codebase: what the pieces are, where data lives, how requests flow.
