#!/usr/bin/env python3
"""Draft catalog entries for a curated set of places from Wikidata.

Runs a SPARQL query for a named set, drops the items catalog.json already
holds (matched by English Wikipedia link, then by name) and writes the rest to
catalog-drafts.json for review. Nothing is written to catalog.json: a person
checks each draft's coordinates on the map, writes `category`, `tags` and
`note`, and moves the entry over by hand. Fields starting with `_` are review
hints (Wikidata item, suggested category and tags, anything odd) and are
dropped on the way into the catalog.

Images come from P18 as 1280 px Commons thumbs, each with `image_credit` from
Commons; an image Commons gives no licence for is left off the draft.

Runs on the maintainer's machine. Wikidata and Commons are queried from here,
never from a user's browser.

  python3 scripts/catalog-wikidata-drafts.py --set unesco [--limit N] [--out FILE] [catalog.json]
"""

import argparse
import hashlib
import importlib.util
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPARQL = "https://query.wikidata.org/sparql"
USER_AGENT = "ferd-catalog-drafts/1.0 (https://github.com/polybjorn/ferd)"
THUMB_WIDTH = 1280

_spec = importlib.util.spec_from_file_location("catalog_image_credits", Path(__file__).resolve().parent / "catalog-image-credits.py")
credits = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(credits)

# A set is the graph pattern that selects its items, plus the tags every
# member clearly carries. Add one here to draft another set.
SETS = {
  "unesco": {
    "where": "?item wdt:P1435 wd:Q9259 .",
    "tags": ["UNESCO"],
  },
}

QUERY = """SELECT ?item ?name ?coord ?countryLabel ?image ?article ?native ?typeLabel WHERE {
  %s
  ?item rdfs:label ?name . FILTER(LANG(?name) = "en")
  OPTIONAL { ?item wdt:P625 ?coord }
  OPTIONAL { ?item wdt:P17 ?country }
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?item wdt:P1705 ?native }
  OPTIONAL { ?item wdt:P31 ?type }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}"""

# P31 label keywords -> category, first match wins, so the narrower kind is
# listed before the broader one ("national park" before "park"). "protected
# area" is left out: Wikidata types cultural sites with it too. Only ever a
# suggestion: the reviewer writes `category`.
CATEGORY_HINTS = [
  ("museum", "museum"),
  ("archaeological site", "ruins"), ("ruins", "ruins"), ("ancient city", "ruins"),
  ("mausoleum", "tomb"), ("necropolis", "tomb"), ("tomb", "tomb"), ("pyramid", "tomb"), ("cemetery", "tomb"),
  ("castle", "castle"), ("fortress", "castle"), ("fortification", "castle"), ("fort", "castle"), ("citadel", "castle"),
  ("palace", "palace"),
  ("church", "religious"), ("cathedral", "religious"), ("basilica", "religious"), ("mosque", "religious"),
  ("temple", "religious"), ("monastery", "religious"), ("abbey", "religious"), ("shrine", "religious"), ("convent", "religious"),
  ("national park", "nature"), ("nature reserve", "nature"), ("mountain", "nature"),
  ("volcano", "nature"), ("waterfall", "nature"), ("cave", "nature"), ("island", "nature"), ("lake", "nature"),
  ("forest", "nature"), ("desert", "nature"), ("reef", "nature"), ("glacier", "nature"), ("canyon", "nature"),
  ("garden", "garden"), ("park", "garden"),
  ("village", "village"),
  ("historic centre", "city"), ("historic center", "city"), ("old town", "city"), ("city", "city"), ("town", "city"),
  ("monument", "monument"), ("tower", "monument"), ("bridge", "monument"), ("statue", "monument"), ("gate", "monument"),
]

# Draft field order: the catalog's own order, then the review hints.
FIELD_ORDER = ["name", "lat", "lon", "country", "local_name", "image", "image_credit", "sources"]

POINT = re.compile(r"^Point\(\s*(-?[0-9.]+)\s+(-?[0-9.]+)\s*\)$")


def parse_point(wkt):
  """Return (lat, lon) rounded to 5 decimals from a WKT Point, or None."""
  m = POINT.match(wkt or "")
  if not m:
    return None
  lon, lat = float(m.group(1)), float(m.group(2))
  return round(lat, 5), round(lon, 5)


def commons_name(file_path_url):
  """Return the Commons file name a P18 Special:FilePath URL names."""
  tail = urllib.parse.urlparse(file_path_url or "").path.rsplit("/", 1)[-1]
  return urllib.parse.unquote(tail).replace(" ", "_")


def _commons_path(name):
  name = name.replace(" ", "_")
  h = hashlib.md5(name.encode("utf-8")).hexdigest()
  return f"{h[0]}/{h[:2]}", urllib.parse.quote(name, safe=""), name


def thumb_url(name, width=THUMB_WIDTH):
  """Build the upload.wikimedia.org thumb URL for a Commons file name."""
  hashed, q, name = _commons_path(name)
  thumb = q + ".png" if name.lower().endswith((".svg", ".tif", ".tiff")) else q
  return f"https://upload.wikimedia.org/wikipedia/commons/thumb/{hashed}/{q}/{width}px-{thumb}"


def original_url(name):
  """Build the upload.wikimedia.org URL of a Commons file itself."""
  hashed, q, _ = _commons_path(name)
  return f"https://upload.wikimedia.org/wikipedia/commons/{hashed}/{q}"


def wiki_key(url):
  """Normalise a Wikipedia article URL so encoded and plain forms compare equal."""
  p = urllib.parse.urlparse(url or "")
  if not p.netloc.endswith("wikipedia.org") or not p.path.startswith("/wiki/"):
    return None
  title = urllib.parse.unquote(p.path[len("/wiki/"):]).replace(" ", "_")
  return f"{p.netloc.lower()}/{title}" if title else None


def suggest_category(types):
  """Suggest a category from P31 labels, or None."""
  labels = [t.lower() for t in types]
  for word, category in CATEGORY_HINTS:
    pattern = re.compile(r"\b" + re.escape(word) + r"\b")
    if any(pattern.search(label) for label in labels):
      return category
  return None


def _first(values):
  return values[0] if values else None


def group_rows(bindings):
  """Collapse SPARQL result rows into one dict of value lists per item, in first-seen order."""
  items = {}
  for row in bindings:
    item = row["item"]["value"]
    acc = items.setdefault(item, {"item": item, "name": [], "coord": [], "countryLabel": [], "image": [], "article": [], "native": [], "typeLabel": []})
    for key in acc:
      if key == "item" or key not in row:
        continue
      value = row[key]["value"]
      if value not in acc[key]:
        acc[key].append(value)
  return list(items.values())


def build_draft(item, tags=()):
  """Turn one grouped item into a draft entry, or None when it has no usable coordinates."""
  points = [p for p in (parse_point(c) for c in item["coord"]) if p]
  if not points:
    return None
  name = item["name"][0]
  review = []
  if len(points) > 1:
    review.append(f"{len(points)} coordinates on Wikidata, took the first")
  countries = sorted(item["countryLabel"])
  if len(countries) > 1:
    review.append("several countries: " + ", ".join(countries))
  draft = {"name": name, "lat": points[0][0], "lon": points[0][1]}
  if countries:
    draft["country"] = countries[0]
  else:
    review.append("no country on Wikidata")
  native = _first(item["native"])
  if native and native != name:
    draft["local_name"] = native
  image = _first(item["image"])
  if image:
    draft["image"] = thumb_url(commons_name(image))
  article = _first(item["article"])
  if article:
    draft["sources"] = [article]
  draft["_wikidata"] = item["item"]
  category = suggest_category(item["typeLabel"])
  if category:
    draft["_suggested_category"] = category
  if tags:
    draft["_suggested_tags"] = list(tags)
  if item["typeLabel"]:
    draft["_instance_of"] = item["typeLabel"]
  if review:
    draft["_review"] = review
  return draft


def known_keys(catalog):
  """Wikipedia keys and casefolded names of the entries catalog.json holds."""
  links, names = set(), set()
  for e in catalog:
    names.add(e["name"].casefold())
    for url in e.get("sources", []):
      key = wiki_key(url)
      if key:
        links.add(key)
  return links, names


def is_known(draft, links, names):
  """True when catalog.json already holds the draft's place: same Wikipedia link, else same name."""
  if any(wiki_key(u) in links for u in draft.get("sources", [])):
    return True
  return draft["name"].casefold() in names


def fetch_image_info(names):
  """Map each Commons file name to (extmetadata, pixel width) for one batch."""
  params = {
    "action": "query", "format": "json", "formatversion": "2",
    "prop": "imageinfo", "iiprop": "extmetadata|size",
    "iiextmetadatafilter": "Artist|LicenseShortName",
    "titles": "|".join("File:" + n for n in names),
  }
  req = urllib.request.Request(credits.API + "?" + urllib.parse.urlencode(params), headers={"User-Agent": USER_AGENT})
  with urllib.request.urlopen(req, timeout=30) as resp:
    doc = json.load(resp)
  q = doc.get("query", {})
  back = {n["to"]: n["from"] for n in q.get("normalized", [])}
  out = {}
  for page in q.get("pages", []):
    title = back.get(page.get("title"), page.get("title", ""))
    info = page.get("imageinfo") or []
    if info:
      out[title[len("File:"):]] = (info[0].get("extmetadata", {}), info[0].get("width"))
  return out


def attach_credits(drafts, fetch=fetch_image_info, pause=1.0):
  """Give every drafted image its `image_credit`; drop an image Commons gives no licence for.

  A file narrower than the thumb width keeps its original URL, since Commons
  will not scale an image up."""
  todo = {}
  for d in drafts:
    name = credits.commons_file(d.get("image"))
    if name:
      todo.setdefault(name, []).append(d)
  names = list(todo)
  for start in range(0, len(names), credits.BATCH):
    chunk = names[start:start + credits.BATCH]
    info = fetch(chunk)
    for n in chunk:
      meta, width = info.get(n, ({}, None))
      credit = credits.credit_from_extmetadata(meta)
      for d in todo[n]:
        if credit is None:
          del d["image"]
          d.setdefault("_review", []).append(f"image {n} dropped: no licence on Commons")
          continue
        if width and width < THUMB_WIDTH:
          d["image"] = original_url(n)
        d["image_credit"] = credit
        ordered = sorted(d.items(), key=lambda kv: FIELD_ORDER.index(kv[0]) if kv[0] in FIELD_ORDER else len(FIELD_ORDER))
        d.clear()
        d.update(ordered)
    if pause and start + credits.BATCH < len(names):
      time.sleep(pause)


def run_query(set_name):
  query = QUERY % SETS[set_name]["where"]
  req = urllib.request.Request(
    SPARQL, data=urllib.parse.urlencode({"query": query, "format": "json"}).encode(),
    headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"})
  with urllib.request.urlopen(req, timeout=120) as resp:
    return json.load(resp)["results"]["bindings"]


def draft_set(set_name, bindings, catalog, limit=None):
  """Build sorted drafts for a set from SPARQL rows, minus what catalog.json holds.

  Returns (drafts, counts) where counts says how many were skipped and why."""
  links, names = known_keys(catalog)
  drafts, seen = [], set()
  counts = {"known": 0, "no_coordinates": 0, "duplicate_name": 0}
  for item in group_rows(bindings):
    draft = build_draft(item, SETS[set_name]["tags"])
    if draft is None:
      counts["no_coordinates"] += 1
      continue
    if is_known(draft, links, names):
      counts["known"] += 1
      continue
    if draft["name"].casefold() in seen:
      counts["duplicate_name"] += 1
      continue
    seen.add(draft["name"].casefold())
    drafts.append(draft)
  drafts.sort(key=lambda d: d["name"].casefold())
  if limit is not None:
    drafts = drafts[:limit]
  return drafts, counts


def main():
  ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
  ap.add_argument("catalog", nargs="?", default=str(ROOT / "catalog.json"))
  ap.add_argument("--set", required=True, choices=sorted(SETS), help="which curated set to draft")
  ap.add_argument("--limit", type=int, help="draft at most this many entries, by name")
  ap.add_argument("--out", default=str(ROOT / "catalog-drafts.json"), help="where to write the drafts")
  args = ap.parse_args()

  catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
  drafts, counts = draft_set(args.set, run_query(args.set), catalog, args.limit)
  attach_credits(drafts)
  Path(args.out).write_text(json.dumps(drafts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
  print(f"{len(drafts)} drafts written to {args.out}; skipped {counts['known']} already in the catalog, "
        f"{counts['no_coordinates']} without coordinates, {counts['duplicate_name']} sharing a name", file=sys.stderr)
  return 0


if __name__ == "__main__":
  sys.exit(main())
