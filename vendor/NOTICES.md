# Third-party notices

Ferd vendors the third-party libraries listed below under `vendor/`. Each retains its upstream license alongside the source. All licenses are compatible with Ferd's GPL-3.0 license, and the combined work is distributed under GPL-3.0.

Entries are grouped by role: the map core, then top-level plugins loaded on every page, then libraries used only on the trail detail page. Each entry describes what the library does, where to find upstream, and how it's licensed.

If you're contributing, see the [Maintenance](#maintenance) section at the bottom for when and how to update this file.

## Map core

### leaflet
- Purpose: core interactive map library that renders tiles, panes, layers, and handles pan/zoom gestures.
- Version: 1.9.4
- Upstream: https://leafletjs.com
- License: BSD-2-Clause
- Copyright (c) 2010-2024, Volodymyr Agafonkin
- Copyright (c) 2010-2011, CloudMade

## Eagerly-loaded plugins

### leaflet-gpx
- Purpose: parses GPX files and renders the tracks, waypoints, and start/end markers as Leaflet layers.
- Version: 2.2.0
- Upstream: https://github.com/mpetazzoni/leaflet-gpx
- License: BSD-2-Clause
- Copyright (c) Maxime Petazzoni and contributors

### Leaflet.SmoothWheelZoom
- Purpose: replaces Leaflet's stepped wheel zoom with a continuous, animated zoom for desktop mouse and trackpad gestures.
- Version: master (commit f090a2d), retrieved 2026-05-24
- Upstream: https://github.com/mutsuyuki/Leaflet.SmoothWheelZoom
- License: MIT
- Copyright (c) 2018 mutsuyuki
- Note: not published to npm, so `scripts/check-vendor-versions.py` cannot track it.

### Leaflet.TileLayer.NoGap
- Purpose: dumps loaded tiles to a single canvas so gaps don't appear between tile seams on fractional-DPR Android devices.
- Version: 0.3.0
- Upstream: https://github.com/Leaflet/Leaflet.TileLayer.NoGap
- License: BSD-2-Clause
- Copyright (c) Ivan Sanchez Ortega

### supercluster
- Purpose: fast spatial clustering for the place markers on the index map.
- Version: 8.0.1
- Upstream: https://github.com/mapbox/supercluster
- License: ISC
- Copyright (c) Mapbox

## Trail detail (lazy-loaded)

### @raruto/leaflet-elevation
- Purpose: elevation chart shown on a trail detail page, plus the position marker that tracks the cursor along the polyline.
- Version: 2.5.2
- Upstream: https://github.com/Raruto/leaflet-elevation
- License: GPL-3.0-or-later
- Copyright (c) Raruto
- Note: GPL-3.0 is the reason Ferd as a whole is licensed under GPL-3.0.
- Vendored layout: the main bundle lives in `leaflet-elevation/`; its lazy-loaded internal modules and bundled third-party libs are in `src/handlers/`, `src/components/`, and `libs/`. The `libs/` folder includes third-party code redistributed by leaflet-elevation (leaflet-hotline by iosphere, leaflet-edgescale by jjimenezshaw, leaflet-distance-marker by raruto). All compatible with GPL-3.0.

### d3
- Purpose: drives the elevation chart's SVG axes, scales, and brush; lazy-loaded by leaflet-elevation only when a chart is rendered.
- Version: 7.9.0
- Upstream: https://github.com/d3/d3
- License: ISC
- Copyright (c) Mike Bostock

---

## License compatibility summary

| Library | License | GPL-3.0 compatible |
|---|---|---|
| leaflet | BSD-2-Clause | Yes |
| leaflet-gpx | BSD-2-Clause | Yes |
| Leaflet.SmoothWheelZoom | MIT | Yes |
| Leaflet.TileLayer.NoGap | BSD-2-Clause | Yes |
| supercluster | ISC | Yes |
| @raruto/leaflet-elevation | GPL-3.0-or-later | Same license |
| d3 | ISC | Yes |

BSD-2-Clause, BSD-3-Clause, ISC, and MIT are on the FSF's [list of GPL-compatible licenses](https://www.gnu.org/licenses/license-list.html). Each component retains its original license; redistribution of the combined work is under GPL-3.0.

---

## Maintenance

This file must be updated whenever a vendored dependency is **added, removed, replaced, or version-bumped**. Keep the entry's role group, purpose line, version, upstream URL, and license accurate. If the new version's license differs from the previous one, also update the compatibility summary table and confirm the new license is GPL-3.0-compatible before merging.

`scripts/check-vendor-versions.py` reads `scripts/vendor-versions.json` and reports drift against npm; keep both files in sync when bumping. Dependencies not published to npm should still be listed here but skipped in the version manifest.
