# Third-party notices

Ferd vendors the third-party libraries listed below under `vendor/`. Each retains its upstream license alongside the source. All of them are on the FSF's [list of GPL-compatible licenses](https://www.gnu.org/licenses/license-list.html); the combined work is distributed under GPL-3.0.

## Map core

### leaflet
- Purpose: core interactive map library that renders tiles, panes, layers, and handles pan/zoom gestures.
- Version: 1.9.4
- Upstream: https://leafletjs.com
- License: BSD-2-Clause
- Copyright: (c) 2010-2024 Volodymyr Agafonkin; (c) 2010-2011 CloudMade
## Eagerly-loaded plugins

### leaflet-gpx
- Purpose: parses GPX files and renders the tracks, waypoints, and start/end markers as Leaflet layers.
- Version: 2.2.0
- Upstream: https://github.com/mpetazzoni/leaflet-gpx
- License: BSD-2-Clause
- Copyright: (c) Maxime Petazzoni and contributors
### Leaflet.TileLayer.NoGap
- Purpose: dumps loaded tiles to a single canvas so gaps don't appear between tile seams on fractional-DPR Android devices.
- Version: 0.3.0
- Upstream: https://github.com/Leaflet/Leaflet.TileLayer.NoGap
- License: Beer-Ware, from the upstream LICENSE file:

  "THE BEER-WARE LICENSE":
  <ivan@sanchezortega.es> wrote this file. As long as you retain this notice you
  can do whatever you want with this stuff. If we meet some day, and you think
  this stuff is worth it, you can buy me a beer in return.

### supercluster
- Purpose: fast spatial clustering for the place markers on the index map.
- Version: 9.1.0
- Upstream: https://github.com/mapbox/supercluster
- License: ISC
- Copyright: (c) Mapbox
## Views

The ES module builds, renamed from `.mjs` to `.js` so that every server and the Android asset loader send them as JavaScript. `index.html` maps the bare imports to these files.

### preact
- Purpose: renders the dialogs built as components (`app/view.js`) and keeps their controls in step with their state.
- Version: 11.0.2
- Files: `dist/preact.mjs` as `preact/preact.js`, `hooks/dist/hooks.mjs` as `preact/hooks.js`
- Upstream: https://preactjs.com
- License: MIT
- Copyright: (c) 2015-present Jason Miller
### @preact/signals
- Purpose: holds the map's places, areas, routes, labels, settings and sign-in state (`app/store.js`), so the views update when they change.
- Version: 2.11.4, with @preact/signals-core 1.14.5
- Files: `dist/signals.mjs` as `signals/signals.js`, `@preact/signals-core`'s `dist/signals-core.mjs` as `signals/signals-core.js`
- Upstream: https://github.com/preactjs/signals
- License: MIT
- Copyright: (c) 2022-present Preact Team
### htm
- Purpose: tagged template syntax for those components, so they need no build step.
- Version: 3.1.1
- Files: `dist/htm.mjs` as `htm/htm.js`
- Upstream: https://github.com/developit/htm
- License: Apache-2.0
- Copyright: (c) 2018 Google Inc.
## Trail detail (lazy-loaded)

### @raruto/leaflet-elevation
- Purpose: elevation chart shown on a trail detail page, plus the position marker that tracks the cursor along the polyline.
- Version: 2.9.2
- Upstream: https://github.com/Raruto/leaflet-elevation
- License: GPL-3.0-or-later
- Copyright: (c) Raruto
- Notes: bundles three helpers under `libs/`, all GPL-3.0-compatible. None carries a version of its own, so each is the copy shipped in the 2.9.2 npm package's `libs/`:
  - leaflet-hotline: Leaflet.hotline, (c) 2017 iosphere GmbH, https://github.com/iosphere/Leaflet.hotline
  - leaflet-edgescale: (c) 2023 Raruto, GPL-3.0-or-later, incorporating Leaflet.EdgeScaleBar (Dražen Tutić, GPL-3.0+) and Leaflet.MapCenterCoord (Xisco Guaita, MIT)
  - leaflet-distance-marker: (c) 2022 Raruto, GPL-3.0-or-later, incorporating work by Doroszlai Attila and Phil Whitehurst under an ISC-style permission notice
- Not vendored: `@tmcw/togeojson`. `leaflet-elevation.js` names it as `__TOGEOJSON`, an unpkg.com URL, and imports it only from `_parseFromString`, which only `load()` and `_loadFile()` call to turn a GPX/KML/TCX string or URL into GeoJSON. Ferd never calls either: `index.html` hands the control ready-made GeoJSON through `addData()`, so the browser never requests unpkg.com. Vendor it and add it to `scripts/vendor-versions.json` if ferd ever starts calling `load()`.

## Visited countries (lazy-loaded)

### Natural Earth admin-0 countries
- Purpose: country outlines for the opt-in visited-countries layer (`natural-earth/countries.geo.json`), plus the name-to-code table the API uses to set `country_code` on places (`natural-earth/country-names.json`).
- Version: 5.1.2, 1:10m `ne_10m_admin_0_countries.geojson`
- Upstream: https://github.com/nvkelso/natural-earth-vector
- License: public domain (https://www.naturalearthdata.com/about/terms-of-use/)
- Notes: not the upstream file. `scripts/build-countries.py` merges features by ISO 3166-1 alpha-2 code (`ISO_A2_EH`), drops those with none (Somaliland, Northern Cyprus, Siachen Glacier), simplifies to about 2 km and keeps only the code. `country-list.json` holds one display name per code, from `ADMIN` with a few overrides in the script. Borders are Natural Earth's de facto lines: they show control on the ground and take no position on a dispute. A place shades the country named in its Country field, never the one its pin falls in. Not on npm, so not in `scripts/vendor-versions.json`; to bump, download the new tag's file and re-run the script.

---

## Maintenance

Adding, removing, replacing, or bumping a vendored dep means updating the entry here.

Version drift is tracked by Renovate, which reads `scripts/vendor-versions.json` and opens a forge PR per pin. Deps not on npm are listed here but omitted from that manifest.
