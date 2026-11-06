# Configuration

Two config files. Both are gitignored; copy the `.example` versions to start.

- `site-config.json`: read by the browser. Brand, default map view, API base path, map overlays.
- `tools/config.json`: read by the API server. Listen address, paths, password/cookie/body-size policy, optional pre-seeded admin credentials.

Every key in `tools/config.json` can also be set via an `FERD_<UPPER>` environment variable. Env wins over the file.

## `site-config.json`

| Field | Default | Notes |
|---|---|---|
| `brand` | `"Ferd"` | Page title and the brand text in the nav. |
| `features` | `{ "places": true, "routes": true }` | Hard switch. Turning a feature off hides its tab, skips its data fetch, and drops its layer/panel from the unified map. With only `routes` on, the unified map opens at `default_view_routes`. Signed-in users can additionally hide an available feature per-browser from Settings (data is still fetched in that case). |
| `default_view` | `{ "center": [45, 10], "zoom": 4 }` | Initial map center and zoom for the unified view. |
| `default_view_routes` | `{ "center": [59.5, 6.5], "zoom": 10 }` | Initial center/zoom used by the route detail view before the GPX bounds are known. |
| `api_base` | `"/api"` | Path prefix the frontend calls. The server itself always answers on `/api/*`, so change this only when a reverse proxy rewrites the prefix back. |
| `overlays` | `[]` | Map layers drawn over the base map, such as topo, hillshade or protected areas. See [Overlays](#overlays). |

### Overlays

Each entry in `overlays` adds an opacity slider to the map's layer picker, where 0 is off. Every slider starts at 0 on each page load, because turning an overlay on sends tile requests to its host.

```json
"overlays": [
  {
    "name": "Topo (Kartverket)",
    "url": "https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png",
    "attribution": "&copy; Kartverket"
  },
  {
    "name": "Grey topo (Kartverket)",
    "url": "https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png",
    "attribution": "&copy; Kartverket"
  },
  {
    "name": "Hillshade",
    "type": "wms",
    "url": "https://wms.geonorge.no/skwms1/wms.terrengmodell",
    "layers": "relieff",
    "attribution": "&copy; Kartverket"
  },
  {
    "name": "CyclOSM",
    "url": "https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
    "max_zoom": 20,
    "attribution": "<a href=\"https://www.cyclosm.org\">CyclOSM</a> &middot; &copy; <a href=\"https://osm.org/copyright\">OpenStreetMap</a> contributors"
  },
  {
    "name": "Sentinel-2 (EOX)",
    "url": "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
    "attribution": "<a href=\"https://cloudless.eox.at\">EOxCloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)"
  }
]
```

Both Kartverket layers cover Norway only. From zoom 12 to 20 they hold Geovekst data, which needs Kartverket's permission to copy, so these examples leave `offline` off.

CyclOSM is hosted by OSM France, whose [usage conditions](https://www.openstreetmap.fr/usage/) cover public, non-profit sites with moderate traffic. Check that your install fits them before adding it, and leave `offline` off: [cyclosm.org](https://www.cyclosm.org/) allows caching its tiles for a few hours at most.

EOX's Sentinel-2 cloudless mosaic is free for non-commercial use; commercial use needs a licence from [EOX](https://cloudless.eox.at). Leave `offline` off for it too, since its terms do not cover caching tiles.

| Field | Default | Notes |
|---|---|---|
| `name` | required | Label in the layer picker. Must be unique. |
| `url` | required | `http(s)` tile URL. For `xyz`, a template with `{z}`, `{x}`, `{y}` and optionally `{s}`. For `wms`, the service endpoint without a query string. |
| `type` | `"xyz"` | `"xyz"` or `"wms"`. |
| `attribution` | `""` | Credit shown in the map corner while the overlay is on, and always in About. HTML is allowed. |
| `max_zoom` | none | Highest zoom the host serves. |
| `subdomains` | `"abc"` | `xyz` only: the letters `{s}` expands to. |
| `layers` | required for `wms` | Comma-separated WMS layer names. |
| `format`, `styles`, `version`, `transparent` | `"image/png"`, `""`, `"1.1.1"`, `true` | `wms` only: passed through to the WMS request. |
| `offline` | `false` | `true` keeps this host's tiles in the service worker's tile cache for offline use. Set it only when the provider's terms allow keeping tiles. Caching is per host, so one entry with `offline: true` covers every overlay on that host. |

An entry with no name, a repeated name, a non-http URL, an unknown type, or a WMS entry without `layers` is skipped. The picker shows only when "Tile picker" is on in Settings.

The service worker reads the same list and keeps tiles offline only from hosts of entries with `offline: true`. Tiles from the others go through the browser's normal HTTP cache, which follows the host's cache headers, and do not show offline. If your reverse proxy sets a Content-Security-Policy, add each overlay host to `img-src`.

## `tools/config.json`

| Field | Env | Default | Notes |
|---|---|---|---|
| `bind` | `FERD_BIND` | `"127.0.0.1:8091"` | Host and port to listen on. Loopback by default; expose externally only through a reverse proxy. |
| `db_path` | `FERD_DB_PATH` | `"tools/app.db"` | SQLite file for users and sessions. Created mode 0600. |
| `data_dir` | `FERD_DATA_DIR` | `"."` | Where `users/<username>/` per-user folders are rooted and where `site-config.json` lives. |
| `manifest_cmd` | `FERD_MANIFEST_CMD` | `null` | Command to run after a successful GPX upload to regenerate that user's `routes.json`. Invoked with `shell=False`, 60s timeout, `cwd=users/<username>/`, with the user's folder passed as `$1`. Relative paths are resolved against `data_dir`. |
| `secure_cookies` | `FERD_SECURE_COOKIES` | `true` | Sets the `Secure` flag on the session cookie. Disable only for plain-HTTP local dev. |
| `max_body_bytes` | `FERD_MAX_BODY_BYTES` | `1048576` | Cap on JSON request bodies. GPX uploads have a separate hard cap of 10 MiB. |
| `static_dir` | `FERD_STATIC_DIR` | `null` | If set, the API also serves static files from this directory for any non-`/api/*` GET. Use this only for development; in production let nginx serve static. |
| `idle_exit_seconds` | `FERD_IDLE_EXIT_SECONDS` | `0` | If > 0, the process exits after this many seconds with no requests. Pair with systemd socket activation for zero-idle RAM. |
| `require_setup_token` | `FERD_REQUIRE_SETUP_TOKEN` | `false` | If true and no users exist, generate a one-time token printed to stderr; the first registration must supply it. A user table that empties while the API runs gets a fresh token at the next registration attempt. See [SECURITY](../SECURITY.md). |
| `cors_origins` | `FERD_CORS_ORIGINS` | `"*"` | Allowed origins for cross-origin clients (native/WebView shells that bundle the frontend and point at this server). `"*"` allows any origin; set to a JSON list of exact origins (`["https://app.example.com"]`) to restrict, or `[]` to disable CORS. The env var sets a single origin or `"*"`; use the file for a list. Cross-origin requests authenticate with bearer tokens and no cookies, so credentials are never allowed and `"*"` exposes nothing an unauthenticated HTTP client couldn't already reach. |
| `trusted_proxies` | `FERD_TRUSTED_PROXIES` | `[]` | Reverse-proxy addresses whose `X-Real-IP` / `X-Forwarded-For` headers are trusted for the client IP. Behind a proxy the socket peer is always the proxy, so without this every client shares one login rate-limit bucket and session/audit records show the proxy's address. Set to `["127.0.0.1"]` when nginx proxies from the same host. Leave empty when clients connect directly - a trusted header from an untrusted peer would let clients spoof their IP. The env var takes a comma-separated list. |
| `initial_user` | `FERD_INITIAL_USER` | `null` | If set with `initial_password`, the admin account is created on first start. Both fields are ignored on later starts once any user exists. |
| `initial_password` | `FERD_INITIAL_PASSWORD` | `null` | See `initial_user`. Must be at least 12 characters. |

## Data files

These are not config but the API and frontend assume they exist at these paths. Per-user content lives under `data_dir/users/<username>/`; site-wide config lives at the `data_dir` root.

| Path (relative to `data_dir`) | Used by | Notes |
|---|---|---|
| `users/<u>/places.json` | API read+write (`/api/places`, `/api/u/<u>/places`) | JSON array of place objects. Writes are atomic via tmp file + rename + fsync. Symlinks are preserved. |
| `users/<u>/areas.json` | API read+write (`/api/areas`, `/api/u/<u>/areas`) | JSON array of area objects. Written the same way as `places.json`. |
| `users/<u>/gpx/<Region>/<Route>.gpx` | API read+write (`/api/gpx/...`, `/api/u/<u>/gpx/...`) | Per-region directory of GPX files. `<Route>.planned.gpx` siblings are rendered as dashed overlays. Region is optional: a GPX at `users/<u>/gpx/<Route>.gpx` (no region subdir) is served at `/api/gpx/<Route>.gpx` and listed under the "No region" group. |
| `users/<u>/routes.json` | API read | Generated by `gpx-manifest.sh` after each GPX upload/delete. Never edit by hand. |
| `users/<u>/metadata.json` | API read+write (`/api/metadata`) | Per-route overrides keyed by `Region/Route name` (or just `Route name` for no-region routes). Each entry may include `source` (URL), `date_completed` (YYYY-MM-DD), `rating` (1-5), `notes`, `tags` (array), `difficulty` (easy / moderate / hard / expert), `local_name` (native form of the route name). Edited from the route Edit modal in the UI. The manifest regenerates after each write so `routes.json` reflects the new values. |
| `users/<u>/prefs.json` | API (`/api/me/prefs`) | Per-user UI preferences that should follow the account across browsers. |
| `users/<u>/category-labels.json` | API (`/api/me/category-labels`, `/api/u/<u>/category-labels`) | Per-user category map, `{slug: {label, color?, order?}}`: display label, palette index, and position in Manage categories. Edited from Settings -> General -> Categories. |
| `catalog.local.json` | API (`/api/catalog`, `/api/admin/catalog/*`) | This instance's own catalog additions, merged with the shipped `catalog.json` at read time. Admin-managed from Manage catalog; see [catalog.md](catalog.md). |
| `site-config.json` | Browser (fetched at boot) | Site-wide config: brand, feature flags, default view. The API only touches it for a one-time migration of legacy category labels. |

For the place object and route metadata schemas (what fields are valid in `places.json` and `metadata.json`), see [api.md > Common shapes](api.md#common-shapes).

## Per-user publish

Each user has a `published` flag (default off) stored in SQLite. With it on, anyone can read that user's map at `/u/<username>/` without signing in; the server returns 404 for unpublished users. The flag is exposed through `POST /api/me/publish`; the toggle lives in the in-browser Settings dialog.
