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
- Version: master at commit a68e52f (2026-03-25); the vendored file is byte-identical to it, and SmoothWheelZoom.js last changed upstream in 39d9f58 (2022-11-12). The earlier record named a commit f090a2d that does not exist upstream.
- Upstream: https://github.com/mutsuyuki/Leaflet.SmoothWheelZoom
- License: MIT
- Copyright: (c) 2018 mutsuyuki
- Notes: not published to npm, so Renovate cannot track it.

### Leaflet.TileLayer.NoGap
- Purpose: dumps loaded tiles to a single canvas so gaps don't appear between tile seams on fractional-DPR Android devices.
- Version: 0.3.0
- Upstream: https://github.com/Leaflet/Leaflet.TileLayer.NoGap
- License: BSD-2-Clause
- Copyright: (c) Ivan Sanchez Ortega
### supercluster
- Purpose: fast spatial clustering for the place markers on the index map.
- Version: 9.1.0
- Upstream: https://github.com/mapbox/supercluster
- License: ISC
- Copyright: (c) Mapbox
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

---

## Maintenance

Adding, removing, replacing, or bumping a vendored dep means updating the entry here.

Version drift is tracked by Renovate, which reads `scripts/vendor-versions.json` and opens a forge PR per pin. Deps not on npm are listed here but omitted from that manifest.
