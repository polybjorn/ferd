# Atlas - Claude notes

Private self-hosted Leaflet map (places + GPX trails). Single-file static frontend (`index.html`), optional Python API (`tools/api.py`). Merged from `polybjorn/pinpoints` and `polybjorn/gpx-trails`.

## Local dev

Run the API and static under one origin at http://localhost:8090 with `python3 tools/api.py`.

`tools/config.json` (gitignored, leave in place between sessions):

```json
{
  "bind": "127.0.0.1:8090",
  "db_path": "tools/atlas.db",
  "data_dir": ".",
  "static_dir": ".",
  "manifest_cmd": "./gpx-manifest.sh",
  "initial_user": "admin",
  "initial_password": "atlas-dev-password",
  "secure_cookies": false,
  "max_body_bytes": 1048576
}
```

- `static_dir: "."` makes the API serve `/api/*` and the frontend from the same origin (no CORS, no separate static server).
- `secure_cookies: false` is required for plain-HTTP localhost.
- `initial_user`/`initial_password` seed the operator account on first start; ignored after any user exists.
- Test sign-in: `admin` / `atlas-dev-password`.

Other gitignored dev artifacts: `site-config.json` (copy from `site-config.example.json`), `tools/atlas.db`.

## Testing changes

- `site-config.json` is fetched once at page load. After editing it (feature flags, category labels, brand), hard-reload (Cmd+Shift+R).
- `places.json` and `routes.json` are also fetched once at load; same applies.
- The `features.{places,trails}` flag is the hard switch (skips fetch + hides tab). The per-browser toggle in Settings is a soft hide (data still loads).

## Known TODOs

See README `## TODO`. The next major piece is a region-management UI mirroring the category-label editor in Settings.
