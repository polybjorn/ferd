# Site catalog

The catalog is a shared list of places users can browse and import into their own map. It comes from two sources, merged at read time:

- **Shipped baseline** - `catalog.json` at the repo root, community-curated via PRs, ships with every Ferd instance.
- **Local additions** - `<data_dir>/catalog.local.json`, per-instance, gitignored, managed by the instance admin.

`GET /api/catalog` returns the merge. Local entries win on `name` collisions. Each entry carries `_source: "shipped"|"local"`. Admins can suppress individual shipped entries (hide) or the entire baseline (`POST /api/admin/settings/catalog-baseline`); see [api.md](api.md#admin) for the full endpoint surface.

Users browse via the Add modal's Browse tab in the Places list. Importing an entry stamps `from_catalog: <name>` on the saved place so the Browse list can hide already-imported entries and the Places list can show a bookmark indicator.

## Shipped baseline

Each entry in `catalog.json` is a JSON object with these fields, in this order:

- `name` - English/Latin-script display name. Used for dedup and Browse search.
- `lat`, `lon` - 5 decimals (~1 m, matches the in-app picker). Source from OSM Nominatim or by picking on the map in the app, not from Wikipedia's "geo" links (often village-center, not the specific landmark).
- `category` - one of the slugs in `CATEGORY_VOCAB` (`tests/test_shipped_catalog.py`). New slugs go in the same PR.
- `country` - country name in English.
- `local_name` - the place's name in the local language, in Latin romanization (e.g. `Akropoli tis Lindou`, `Takht-e Jamshid`, `Gosudarstvenny Ermitazh`). Use the standard transliteration; don't store native script. Omit if the romanized form equals `name`.
- `note` - one-line identifier, max 60 chars.
- `image` - stable thumbnail URL. For Wikipedia Commons sources, always use the 1280 px thumb form (`https://upload.wikimedia.org/wikipedia/commons/thumb/X/XY/<file>/1280px-<file>`), not the full-resolution original (`https://upload.wikimedia.org/wikipedia/commons/X/XY/<file>`). The popup downsizes to ~280 px and the service worker caches repeats, so the original is just wasted bandwidth - often multi-MB per load. Smaller thumb widths often 400 from the thumbnailer; stick to 1280. Prefer landscape (`width >= height`); portrait images crop poorly unless paired with `image_focus`.
- `image_focus` - optional. Crop anchor for the landscape popup frame, applied as CSS `object-position`. Accepts `top`, `bottom`, `left`, `right`, `center`, or `"X% Y%"`. Omit for landscape images (default `center` is fine). Set for portrait images so the meaningful part of the photo stays in frame (e.g. `top` for towers, `bottom` when the foreground matters). The server clears this field automatically when `image` changes, so it always tracks a specific photo.
- `sources` - array of URLs, usually one Wikipedia link. Add more only if a single source can't carry the claim.

Insert new entries in alphabetical order by `name` (case-insensitive). Example:

```json
{
  "name": "Acropolis of Lindos",
  "lat": 36.09154,
  "lon": 28.08854,
  "category": "ruins",
  "country": "Greece",
  "local_name": "Ακρόπολη της Λίνδου",
  "note": "Hilltop citadel with a 4th-century BC Temple of Athena",
  "image": "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/20210826-Lindos-DJI_0205.jpg/1280px-20210826-Lindos-DJI_0205.jpg",
  "sources": ["https://en.wikipedia.org/wiki/Lindos"]
}
```

`tests/test_shipped_catalog.py` (runs in CI) enforces these conventions plus the place schema, so PRs catch malformed entries at review time.

## Local additions

Admins curate the per-instance catalog from the in-app Manage catalog modal, which calls the admin endpoints listed in [api.md](api.md#admin). Promoted places have their visit-only fields (`visited`, `date_visited`, `rating`) stripped on the way in - the catalog describes a place, not a personal visit.
