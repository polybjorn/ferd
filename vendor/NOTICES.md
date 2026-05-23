# Third-party notices

Ferd vendors the following third-party libraries under `vendor/`. Each is governed by its own upstream license, retained alongside the code. All licenses below are compatible with Ferd's GPL-3.0 license; the combined work distributes as GPL-3.0.

Versions are not pinned here on purpose — they're tracked by the files committed under each `vendor/<name>/` and the git history. Update this file only when a dependency is **added, removed, or replaced**, or when an upstream license changes.

## leaflet
- Upstream: https://leafletjs.com
- License: BSD-2-Clause
- Copyright (c) 2010-2024, Volodymyr Agafonkin
- Copyright (c) 2010-2011, CloudMade

## leaflet-gpx
- Upstream: https://github.com/mpetazzoni/leaflet-gpx
- License: BSD-2-Clause
- Copyright (c) Maxime Petazzoni and contributors

## @raruto/leaflet-elevation
- Upstream: https://github.com/Raruto/leaflet-elevation
- License: GPL-3.0-or-later
- Copyright (c) Raruto
- Note: GPL-3.0 is the reason Ferd as a whole is licensed under GPL-3.0.

## Leaflet.TileLayer.NoGap
- Upstream: https://github.com/Leaflet/Leaflet.TileLayer.NoGap
- License: BSD-2-Clause
- Copyright (c) Ivan Sanchez Ortega

## supercluster
- Upstream: https://github.com/mapbox/supercluster
- License: ISC
- Copyright (c) Mapbox

---

## License compatibility summary

| Library | License | GPL-3.0 compatible |
|---|---|---|
| leaflet | BSD-2-Clause | Yes |
| leaflet-gpx | BSD-2-Clause | Yes |
| @raruto/leaflet-elevation | GPL-3.0-or-later | Same license |
| Leaflet.TileLayer.NoGap | BSD-2-Clause | Yes |
| supercluster | ISC | Yes |

BSD-2-Clause and ISC are on the FSF's [list of GPL-compatible licenses](https://www.gnu.org/licenses/license-list.html). Each component retains its original license; redistribution of the combined work is under GPL-3.0.
