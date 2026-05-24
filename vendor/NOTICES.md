# Third-party notices

Ferd vendors the following third-party libraries under `vendor/`. Each is governed by its own upstream license, retained alongside the code. All licenses below are compatible with Ferd's GPL-3.0 license; the combined work distributes as GPL-3.0.

Update this file when a dependency is **added, removed, replaced, or version-bumped**.

## leaflet
- Purpose: core interactive map library that renders tiles, panes, layers, and handles pan/zoom gestures.
- Version: 1.9.4
- Upstream: https://leafletjs.com
- License: BSD-2-Clause
- Copyright (c) 2010-2024, Volodymyr Agafonkin
- Copyright (c) 2010-2011, CloudMade

## leaflet-gpx
- Purpose: parses GPX files and renders the tracks, waypoints, and start/end markers as Leaflet layers.
- Version: 2.2.0
- Upstream: https://github.com/mpetazzoni/leaflet-gpx
- License: BSD-2-Clause
- Copyright (c) Maxime Petazzoni and contributors

## @raruto/leaflet-elevation
- Purpose: elevation chart shown on a trail detail page, plus the position marker that tracks the cursor along the polyline.
- Version: 2.5.2
- Upstream: https://github.com/Raruto/leaflet-elevation
- License: GPL-3.0-or-later
- Copyright (c) Raruto
- Note: GPL-3.0 is the reason Ferd as a whole is licensed under GPL-3.0.
- Vendored layout: the main bundle lives in `leaflet-elevation/`; its lazy-loaded internal modules and bundled third-party libs are in `src/handlers/`, `src/components/`, and `libs/`. The `libs/` folder includes third-party code redistributed by leaflet-elevation (leaflet-hotline by iosphere, leaflet-edgescale by jjimenezshaw, leaflet-distance-marker by raruto). All compatible with GPL-3.0.

## Leaflet.SmoothWheelZoom
- Purpose: replaces Leaflet's stepped wheel zoom with a continuous, animated zoom for desktop mouse and trackpad gestures.
- Version: master (commit f090a2d), retrieved 2026-05-24
- Upstream: https://github.com/mutsuyuki/Leaflet.SmoothWheelZoom
- License: MIT
- Copyright (c) 2018 mutsuyuki
- Note: not published to npm, so `scripts/check-vendor-versions.py` cannot track it.

## Leaflet.TileLayer.NoGap
- Purpose: dumps loaded tiles to a single canvas so gaps don't appear between tile seams on fractional-DPR Android devices.
- Version: 0.3.0
- Upstream: https://github.com/Leaflet/Leaflet.TileLayer.NoGap
- License: BSD-2-Clause
- Copyright (c) Ivan Sanchez Ortega

## supercluster
- Purpose: fast spatial clustering for the place markers on the index map.
- Version: 8.0.1
- Upstream: https://github.com/mapbox/supercluster
- License: ISC
- Copyright (c) Mapbox

## d3
- Purpose: drives the elevation chart's SVG axes, scales, and brush; lazy-loaded by leaflet-elevation only when a chart is rendered.
- Version: 7.9.0
- Upstream: https://github.com/d3/d3
- License: ISC
- Copyright (c) Mike Bostock

## @tmcw/togeojson
- Purpose: converts GPX/KML to GeoJSON; lazy-loaded by leaflet-elevation when ingesting non-leaflet-gpx track sources.
- Version: 7.1.2
- Upstream: https://github.com/tmcw/togeojson
- License: BSD-2-Clause
- Copyright (c) Tom MacWright

## leaflet-geometryutil
- Purpose: distance, bearing, and "closest point on polyline" math; lazy-loaded by leaflet-elevation.
- Version: 0.10.3
- Upstream: https://github.com/makinacorpus/Leaflet.GeometryUtil
- License: BSD-3-Clause (FreeBSD-style)
- Copyright (c) Makina Corpus

## leaflet-almostover
- Purpose: emits "near polyline" mouse events when the cursor is close to (but not on) a line; lazy-loaded by leaflet-elevation.
- Version: 1.0.1
- Upstream: https://github.com/makinacorpus/Leaflet.AlmostOver
- License: MIT
- Copyright (c) Makina Corpus

---

## License compatibility summary

| Library | License | GPL-3.0 compatible |
|---|---|---|
| leaflet | BSD-2-Clause | Yes |
| leaflet-gpx | BSD-2-Clause | Yes |
| @raruto/leaflet-elevation | GPL-3.0-or-later | Same license |
| Leaflet.SmoothWheelZoom | MIT | Yes |
| Leaflet.TileLayer.NoGap | BSD-2-Clause | Yes |
| supercluster | ISC | Yes |
| d3 | ISC | Yes |
| @tmcw/togeojson | BSD-2-Clause | Yes |
| leaflet-geometryutil | BSD-3-Clause | Yes |
| leaflet-almostover | MIT | Yes |

BSD-2-Clause, BSD-3-Clause, ISC, and MIT are on the FSF's [list of GPL-compatible licenses](https://www.gnu.org/licenses/license-list.html). Each component retains its original license; redistribution of the combined work is under GPL-3.0.
