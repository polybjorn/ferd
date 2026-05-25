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
### Leaflet.SmoothWheelZoom
- Purpose: replaces Leaflet's stepped wheel zoom with a continuous, animated zoom for desktop mouse and trackpad gestures.
- Version: master (commit f090a2d), retrieved 2026-05-24
- Upstream: https://github.com/mutsuyuki/Leaflet.SmoothWheelZoom
- License: MIT
- Copyright: (c) 2018 mutsuyuki
- Notes: not published to npm, so `scripts/check-vendor-versions.py` cannot track it.

### Leaflet.TileLayer.NoGap
- Purpose: dumps loaded tiles to a single canvas so gaps don't appear between tile seams on fractional-DPR Android devices.
- Version: 0.3.0
- Upstream: https://github.com/Leaflet/Leaflet.TileLayer.NoGap
- License: BSD-2-Clause
- Copyright: (c) Ivan Sanchez Ortega
### supercluster
- Purpose: fast spatial clustering for the place markers on the index map.
- Version: 8.0.1
- Upstream: https://github.com/mapbox/supercluster
- License: ISC
- Copyright: (c) Mapbox
## Trail detail (lazy-loaded)

### @raruto/leaflet-elevation
- Purpose: elevation chart shown on a trail detail page, plus the position marker that tracks the cursor along the polyline.
- Version: 2.5.2
- Upstream: https://github.com/Raruto/leaflet-elevation
- License: GPL-3.0-or-later
- Copyright: (c) Raruto
- Notes: GPL-3.0 is the reason Ferd as a whole is licensed under GPL-3.0. Main bundle lives in `leaflet-elevation/`; lazy-loaded internal modules and bundled third-party libs are in `src/handlers/`, `src/components/`, and `libs/`. The `libs/` folder redistributes leaflet-hotline (iosphere), leaflet-edgescale (jjimenezshaw), and leaflet-distance-marker (raruto), all GPL-3.0-compatible.

### d3
- Purpose: drives the elevation chart's SVG axes, scales, and brush; lazy-loaded by leaflet-elevation only when a chart is rendered.
- Version: 7.9.0
- Upstream: https://github.com/d3/d3
- License: ISC
- Copyright: (c) Mike Bostock
---

## Maintenance

Adding, removing, replacing, or bumping a vendored dep means updating the entry here. New deps need a GPL-3.0-compatible license.

Version drift is tracked by `scripts/check-vendor-versions.py` against `scripts/vendor-versions.json`. Deps not on npm are listed here but omitted from that manifest.
