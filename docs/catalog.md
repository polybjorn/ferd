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
- `local_name` - native script (e.g. `Ακρόπολη της Λίνδου`, `京都駅`), not a transliteration. Omit if identical to `name`.
- `note` - one-line identifier, max 60 chars.
- `image` - stable thumbnail URL. Wikipedia Commons works (`…/thumb/…/1280px-…`); browsers downsize to ~280 px in the popup and the service worker caches repeats. Stick to 1280 px - smaller widths often 400 from the thumbnailer.
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
