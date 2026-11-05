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

---

## Maintenance

Adding, removing, replacing, or bumping a vendored dep means updating the entry here.

Version drift is tracked by Renovate, which reads `scripts/vendor-versions.json` and opens a forge PR per pin. Deps not on npm are listed here but omitted from that manifest.
