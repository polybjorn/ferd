# Third-party notices

Ferd vendors the following third-party libraries under `vendor/`. Each is governed by its own upstream license, retained alongside the code. All licenses below are compatible with Ferd's GPL-3.0 license; the combined work distributes as GPL-3.0.

Update this file when a dependency is **added, removed, replaced, or version-bumped**.

## leaflet
- Version: 1.9.4
- Upstream: https://leafletjs.com
- License: BSD-2-Clause
- Copyright (c) 2010-2024, Volodymyr Agafonkin
- Copyright (c) 2010-2011, CloudMade

## leaflet-gpx
- Version: 2.2.0
- Upstream: https://github.com/mpetazzoni/leaflet-gpx
- License: BSD-2-Clause
- Copyright (c) Maxime Petazzoni and contributors

## @raruto/leaflet-elevation
- Version: 2.5.2
- Upstream: https://github.com/Raruto/leaflet-elevation
- License: GPL-3.0-or-later
- Copyright (c) Raruto
- Note: GPL-3.0 is the reason Ferd as a whole is licensed under GPL-3.0.
- Vendored layout: the main bundle lives in `leaflet-elevation/`; its lazy-loaded internal modules and bundled third-party libs are in `src/handlers/`, `src/components/`, and `libs/`. The `libs/` folder includes third-party code redistributed by leaflet-elevation (leaflet-hotline by iosphere, leaflet-edgescale by jjimenezshaw, leaflet-distance-marker by raruto). All compatible with GPL-3.0.

## Leaflet.SmoothWheelZoom
- Version: master (commit f090a2d), retrieved 2026-05-24
- Upstream: https://github.com/mutsuyuki/Leaflet.SmoothWheelZoom
- License: MIT
- Copyright (c) 2018 mutsuyuki
- Note: not published to npm, so `scripts/check-vendor-versions.py` cannot track it.

## Leaflet.TileLayer.NoGap
- Version: 0.3.0
- Upstream: https://github.com/Leaflet/Leaflet.TileLayer.NoGap
- License: BSD-2-Clause
- Copyright (c) Ivan Sanchez Ortega

## supercluster
- Version: 8.0.1
- Upstream: https://github.com/mapbox/supercluster
- License: ISC
- Copyright (c) Mapbox

## d3
- Version: 7.9.0
- Upstream: https://github.com/d3/d3
- License: ISC
- Copyright (c) Mike Bostock
- Note: lazy-loaded by leaflet-elevation when rendering an elevation chart.

## @tmcw/togeojson
- Version: 7.1.2
- Upstream: https://github.com/tmcw/togeojson
- License: BSD-2-Clause
- Copyright (c) Tom MacWright
- Note: lazy-loaded by leaflet-elevation to convert GPX/KML to GeoJSON.

## leaflet-geometryutil
- Version: 0.10.3
- Upstream: https://github.com/makinacorpus/Leaflet.GeometryUtil
- License: BSD-3-Clause (FreeBSD-style)
- Copyright (c) Makina Corpus
- Note: lazy-loaded by leaflet-elevation for distance/angle math along polylines.

## leaflet-almostover
- Version: 1.0.1
- Upstream: https://github.com/makinacorpus/Leaflet.AlmostOver
- License: MIT
- Copyright (c) Makina Corpus
- Note: lazy-loaded by leaflet-elevation for "near polyline" mouse interactions.

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
