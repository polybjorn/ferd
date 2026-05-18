# <img src="favicon.svg" width="28" alt="Pinpoints icon"> Pinpoints

Interactive map for plotting and browsing travel destinations.

<p><img src="https://res.cloudinary.com/djpkffk5u/image/upload/c_scale,h_800/v1775115696/Screenshot_2026-04-02_at_10.38.31_vgdx4t.png" width="39.3%" alt="Map view"><img src="https://res.cloudinary.com/djpkffk5u/image/upload/c_scale,h_800/v1775115696/Screen_Shot_2026-04-02_at_10.39.53_vfvmag.png" width="20.04%" alt="Mobile map view"><img src="https://res.cloudinary.com/djpkffk5u/image/upload/c_scale,h_800/v1775115694/Screenshot_2026-04-02_at_10.38.49_ll5hmf.png" width="39.3%" alt="Index view"></p>

## Features

- Index view with places grouped by category or country
- Interactive map with all pins, marker clustering for dense areas
- Category-based color coding with toggleable legend
- Visited / want-to-visit status filtering
- Click a place card to focus it on the map
- Dark theme, responsive design

## File structure

```
places.json         # array of places (name, lat, lon, category, country, visited, note)
index.html          # the app
favicon.svg         # map pin icon
```

## Adding a place

Edit `places.json` and add an entry:

```json
{
  "name": "Place Name",
  "lat": 41.89,
  "lon": 12.49,
  "category": "ruins",
  "country": "Italy",
  "visited": false,
  "note": "Optional description",
  "sources": ["https://example.com/place"],
  "local_name": "Optional local name"
}
```

Categories are free-form strings. Colors are auto-assigned from a fixed palette. Sources and local_name are optional. Sources can contain multiple URLs, shown as clickable links in map popups.

## Setup

Static site. No build step, no dependencies.

```sh
python3 -m http.server 8080
```

## Stack and attribution

- [Leaflet](https://leafletjs.com/) (BSD-2-Clause)
- [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) (MIT)

Tile providers:
- [OpenTopoMap](https://opentopomap.org) - CC-BY-SA
- [CyclOSM](https://www.cyclosm.org) - ODbL (OpenStreetMap)
- [Esri World Imagery](https://www.esri.com) - Esri
- [CARTO](https://carto.com) - CC-BY 3.0
- [OpenStreetMap](https://www.openstreetmap.org) - ODbL

## Place data

`places.json` is excluded from this repository. To use this app, create your own `places.json` with an array of place objects (see "Adding a place" above).

## See also

- [GPX Trails](https://github.com/polybjorn/gpx-trails) - interactive GPX route viewer with elevation profiles and route stats
