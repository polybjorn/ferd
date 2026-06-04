# Site catalog

The catalog is a shared list of places users can browse and import into their own map. It comes from two sources, merged at read time:

- **Shipped baseline** - `catalog.json` at the repo root, community-curated via PRs, ships with every Ferd instance.
- **Local additions** - `<data_dir>/catalog.local.json`, per-instance, gitignored, managed by the instance admin.

`GET /api/catalog` returns the merge. Local entries win on `name` collisions. Each entry carries `_source: "shipped"|"local"`. Admins can suppress individual shipped entries (hide) or the entire baseline (`POST /api/admin/settings/catalog-baseline`); see [api.md](api.md#admin) for the full endpoint surface.

Users browse via the Add modal's Browse tab in the Places list. Importing an entry stamps `from_catalog: <name>` on the saved place so the Browse list can hide already-imported entries and the Places list can show a bookmark indicator.

## Shipped baseline

Each entry is a JSON object with these fields, in this order. `name`, `lat`, `lon`, `category`, and `country` are required; the rest are optional.

- `name` - English/Latin-script display name. Used for dedup and Browse search.
- `lat`, `lon` - 5 decimals (~1 m). Source from OSM Nominatim or the in-app map picker, not Wikipedia's "geo" links (often village-center, not the landmark).
- `category` - one slug from `CATEGORY_VOCAB` (`tests/test_shipped_catalog.py`). See [Categories and tags](#categories-and-tags) for the rules.
- `tags` - labels (`[a-zA-Z0-9][a-zA-Z0-9-]{0,31}`, max 10, deduped case-insensitively, casing kept). Shipped tags must come from `TAG_VOCAB`. See [Categories and tags](#categories-and-tags) for the rules.
- `country` - country name in English.
- `local_name` - the name in its native script (e.g. `Ακρόπολη της Λίνδου`, `تخت جمشید`). Don't transliterate (no `Takht-e Jamshid`). For Latin-script languages, use the native form as-is. Omit if it equals `name`.
- `note` - one-line identifier, max 60 chars.
- `image` - stable thumbnail URL. For Wikipedia Commons, use the 1280 px thumb form (`.../thumb/X/XY/<file>/1280px-<file>`), not the full-res original: the popup shows ~280 px, so the original is wasted multi-MB. Prefer landscape; portrait crops poorly without `image_focus`.
- `image_focus` - crop anchor for the popup frame (CSS `object-position`): `top`/`bottom`/`left`/`right`/`center` or `"X% Y%"`. Omit for landscape; set for portrait so the subject stays in frame (`top` for towers). Cleared automatically when `image` changes.
- `sources` - array of URLs, usually one Wikipedia link. Add more only if one can't carry the claim.

Insert new entries in alphabetical order by `name` (case-insensitive). Example:

```json
{
  "name": "Acropolis of Lindos",
  "lat": 36.09154,
  "lon": 28.08854,
  "category": "ruins",
  "tags": ["Greek"],
  "country": "Greece",
  "local_name": "Ακρόπολη της Λίνδου",
  "note": "Hilltop citadel with a 4th-century BC Temple of Athena",
  "image": "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/20210826-Lindos-DJI_0205.jpg/1280px-20210826-Lindos-DJI_0205.jpg",
  "sources": ["https://en.wikipedia.org/wiki/Lindos"]
}
```

`tests/test_shipped_catalog.py` (runs in CI) enforces these conventions plus the place schema, so PRs catch malformed entries at review time.

## Categories and tags

Rules for assigning `category` and `tags`, kept here so the taxonomy stays consistent as the catalog grows.

### Principle

- A **category** answers "what kind of place is this?" with one mutually-exclusive choice: a *fundamental kind*, not a sub-type of another, kept at a consistent level of detail. One per entry, required.
- A **tag** is an attribute that is *not* the identity: several can stack on one entry, a tag can apply across categories, and tags are what the filter works on. Optional; every tag belongs to one **dimension**.
- **Sub-feature rule:** a category may not be a sub-type of another category. If X is a kind of Y, X is a tag in Y's dimension, not its own category. A beach is a kind of natural site, so it is a `Beach` tag on `nature`, not a `beach` category.

### Categories

The controlled set (`CATEGORY_VOCAB`):

| Category | What it is |
|---|---|
| `museum` | An institution and its collection (art, history, science). |
| `monument` | A notable built structure or landmark with no more specific category: gates, towers, arches, fountains, statues, memorials. Intentionally broad; the specific kind goes in a Type tag. |
| `ruins` | The surviving remains of an ancient or abandoned site. Names a state more than a type; what it once was and who built it go in tags. |
| `tomb` | A burial monument: mausoleum, necropolis, royal or rock-cut tomb, funerary pyramid. |
| `religious` | A place of worship or sacred site: church, temple, mosque, shrine, monastery. |
| `nature` | A natural site. A broad bucket; the specific feature goes in a Landscape tag. |
| `castle` | A fortification: castle, fort, or citadel. |
| `garden` | A man-made designed outdoor space (garden or park), distinct from wild `nature`. |
| `city` | A settlement visited as a whole, such as a historic town or old town. |
| `palace` | A grand residence, royal or noble. |

### Choosing between categories

When more than one fits, decide in this order:

- **Condition first, for old sites.** A ruined temple or fort is `ruins`, not `religious`/`castle`. A place of worship still in use is `religious`; once it is mainly a ruin, `ruins`.
- **Identity over current use.** A palace now run as a museum is a `palace`; a fort now a museum is a `castle`. The category is what the place *is*, not how it is used today.
- **Defense vs residence.** A fortified residence is `castle` if the defenses dominate, `palace` if the living quarters do.
- **Part vs whole.** A single landmark inside a historic town is `monument` (or its specific category); the town taken as a whole is `city`.

### Tag dimensions

The controlled set (`TAG_VOCAB`), grouped by dimension:

| Dimension | Applies to | Tags |
|---|---|---|
| Designation | any category | `UNESCO` |
| Civilization | built or historical sites (`ruins`/`monument`/`religious`/`castle`/`palace`/`city`) | `Roman`, `Greek`, `Persian`, `Byzantine`, `Maya`, `Khmer`, ... |
| Landscape | a `nature` site | `Volcano`, `Waterfall`, `Cave`, `Beach` |
| Type | a built site, across categories | `Amphitheatre`, `Theatre`, `Bath`, `Aqueduct`, `Bridge`, `Square`, `Gate`, `Arch`, `Fountain`, `Caravanserai`, `Statue`, `Pyramid`, `Tower` |

Type cuts across the loose categories, so the precise kind stays filterable even when the category is broad: every amphitheatre shares the `Amphitheatre` tag whether it is categorized `ruins` (Colosseum) or `monument` (Verona Arena).

Designation, Landscape, and Type are listed in full; Civilization is illustrative (`TAG_VOCAB` is authoritative). A site can carry several Civilization tags (multiple periods, in build order) or none (modern and natural sites).

### Assignment rules

- Pick the single most specific category that fits.
- Add a shipped category only when it is a distinct, legible kind of place that isn't a sub-type of an existing category. Anything finer, or cross-cutting, is a tag.
- Apply a tag only when the place clearly has that trait. Leaving a tag off is fine and keeps the tags that are present meaningful. Don't force a tag onto a place with no clear one (a fauna park carries no Landscape tag).
- For Civilization, tag the culture that built or defines the place, not its architectural style and not its era. Prefer the specific empire over a religion; don't invent national labels (no "French").
- Add to either vocab deliberately, in the same PR that first uses a new term. CI fails on any category or tag outside its vocab.

## Local additions

Admins curate the per-instance catalog from the in-app Manage catalog modal, which calls the admin endpoints listed in [api.md](api.md#admin). Promoted places have their visit-only fields (`visited`, `date_visited`, `rating`) stripped on the way in - the catalog describes a place, not a personal visit.

The `CATEGORY_VOCAB` and `TAG_VOCAB` controls cover only the shipped `catalog.json` (the test reads that file). Local additions are not vocab-restricted, so an admin can use any category or tag there.
