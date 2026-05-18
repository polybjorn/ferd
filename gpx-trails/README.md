# <img src="favicon.svg" width="28" alt="GPX Trails icon"> GPX Trails

Lightweight GPX route viewer with interactive maps, elevation profiles, and route stats.

<p><img src="https://res.cloudinary.com/djpkffk5u/image/upload/c_scale,h_800/v1773827117/Screenshot_2026-03-18_at_12.43.40_gl0qyi.png" width="39.3%" alt="Route detail view"><img src="https://res.cloudinary.com/djpkffk5u/image/upload/c_scale,h_800/v1773828074/Screen_Shot_2026-03-18_at_12.58.19_urgdx4.png" width="20.04%" alt="Mobile route list"><img src="https://res.cloudinary.com/djpkffk5u/image/upload/c_scale,h_800/v1773827118/Screenshot_2026-03-18_at_12.44.17_w5xyts.png" width="39.3%" alt="Overview map"></p>

## Features

- Route index grouped by region
- Overview map with all routes
- Per-route detail view with map, elevation profile, and stats (distance, gain, loss, peak, estimated time)
- Multi-track GPX support with per-track colors, collapsible elevation charts, and track legend
- Dual-track convention: `Route.gpx` (recorded) + `Route.planned.gpx` (planned reference) shown as dashed overlay
- Completion status derived from file existence -no config needed
- Dark theme, responsive design for desktop and mobile

## File structure

```
gpx/
  Region/
    Route Name.gpx              # recorded track (= completed)
    Route Name.planned.gpx      # planned reference route
metadata.json                   # optional source URLs for routes
gpx-manifest.sh                 # generates routes.json from gpx/ directory
index.html                      # the app
favicon.svg                     # mountain silhouette icon
```

## Adding a route

1. Drop the `.gpx` file into `gpx/Region/`
   - Recorded track: `Route Name.gpx`
   - Planned route: `Route Name.planned.gpx`
   - Both can exist for the same route
2. Optionally add a `source` URL in `metadata.json`
3. Run `./gpx-manifest.sh` to regenerate `routes.json`

## Multi-track GPX

A single `.gpx` file can contain multiple `<trk>` elements (stages, alternatives). Each track renders with a distinct color, its own elevation chart, and per-track stats in the legend.

## Setup

Served as a static site. No build step, no dependencies.

The manifest script scans `gpx/` for `.gpx` and `.planned.gpx` files, detects elevation data and multi-track info, reads metadata, and generates `routes.json`.

```sh
./gpx-manifest.sh

# serve locally
python3 -m http.server 8080
```

## Stack and attribution

- [Leaflet](https://leafletjs.com/) (BSD-2-Clause) -maps
- [leaflet-gpx](https://github.com/mpetazzoni/leaflet-gpx) (BSD-2-Clause) -GPX rendering
- [leaflet-elevation](https://github.com/Raruto/leaflet-elevation) (GPL-3.0) -elevation profiles

Tile providers:
- [OpenTopoMap](https://opentopomap.org) -CC-BY-SA
- [CyclOSM](https://www.cyclosm.org) -ODbL (OpenStreetMap)
- [Esri World Imagery](https://www.esri.com) -Esri
- [CARTO](https://carto.com) -CC-BY 3.0
- [OpenStreetMap](https://www.openstreetmap.org) -ODbL

## GPX data

GPX files are excluded from this repository. To use this app, add your own GPX files to `gpx/Region/` and run `./gpx-manifest.sh`.

GPX files can contain PII (timestamps, device identifiers, and coordinates that may reveal home locations). A pre-commit hook is included that automatically strips `<time>`, `<author>`, and `creator` attributes from staged `.gpx` files.

Set it up after cloning:

```sh
cp hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## See also

- [Pinpoints](https://github.com/polybjorn/pinpoints) - interactive map for plotting and browsing travel destinations
