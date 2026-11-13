#!/usr/bin/env python3
"""Build a demo dataset for screenshots as an import zip.

Writes a zip in the /me/export shape: places.json, metadata.json,
category-labels.json and a few GPX tracks carrying <ele>, so the route detail
draws an elevation profile and the History tab has dated entries across
several years. Load it into a throwaway account with
POST /api/me/import?mode=replace (see docs/screenshots/README.md).

Everything is synthetic: the names are invented and the tracks are generated
curves with hand-shaped elevation, laid over an alpine area so the base map
has some relief. Output is deterministic, so a rerun gives the same bytes.

The default set is small and fixed, since the screenshots and the browser
tests build on it. --large adds what a preview needs to exercise the map: a
dense region of about 150 places so clusters form at several zoom levels,
places in several real countries so Visited countries has something to shade,
three areas (one holding places and a route, so its counts show) and more
routes, one of them long.

Usage: python3 scripts/demo-data.py [-o demo-data.zip] [--large]

Stdlib only.
"""
import argparse
import io
import json
import math
import random
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

GPX_NS = "http://www.topografix.com/GPX/1/1"
# Fixed archive timestamp, so the zip is byte-identical across runs.
ZIP_DATE = (2025, 1, 1, 0, 0, 0)
# Metres per degree of latitude; longitude is scaled by cos(lat).
M_PER_DEG = 111_320

# Each route is a closed or open curve around a centre point, sampled every
# ~40 m. `shape` picks the curve, `profile` maps progress 0..1 to elevation.
ROUTES = [
  {
    "region": "Demo Highlands", "name": "Ridge Climb", "completed": True,
    "centre": (46.512, 9.871), "shape": "out-and-back", "length_km": 11.0,
    "bearing": 35, "profile": lambda t: 980 + 1420 * math.sin(math.pi * t) ** 1.4,
    "meta": {"date_completed": "2024-07-14", "rating": 5, "difficulty": "hard",
             "tags": ["summit", "viewpoint"],
             "notes": "Steady climb to the ridge, back the same way."},
  },
  {
    "region": "Demo Highlands", "name": "Lake Loop", "completed": True,
    "centre": (46.468, 9.812), "shape": "loop", "length_km": 7.5,
    "bearing": 0, "profile": lambda t: 1180 + 90 * math.sin(2 * math.pi * t) + 45 * math.sin(6 * math.pi * t),
    "meta": {"date_completed": "2025-06-02", "rating": 4, "difficulty": "easy",
             "tags": ["loop", "lake"]},
  },
  {
    "region": "Demo Highlands", "name": "Valley Traverse", "completed": False,
    "centre": (46.540, 9.950), "shape": "arc", "length_km": 16.0,
    "bearing": 110, "profile": lambda t: 1450 + 520 * math.sin(math.pi * t) - 260 * t,
    "meta": {"difficulty": "moderate", "tags": ["traverse"]},
  },
  {
    "region": "Lowland Trails", "name": "Forest Circuit", "completed": True,
    "centre": (46.420, 9.700), "shape": "loop", "length_km": 9.0,
    "bearing": 0, "profile": lambda t: 820 + 160 * math.sin(math.pi * t) ** 2,
    "meta": {"date_completed": "2023-09-10", "rating": 3, "difficulty": "moderate",
             "tags": ["loop", "forest"]},
  },
]

PLACES = [
  {"name": "Old Watchtower", "lat": 46.498, "lon": 9.842, "category": "castle",
   "country": "Demo", "visited": True, "date_visited": "2025-06-02", "rating": 4,
   "note": "Ruined tower above the lake, open stair to the top."},
  {"name": "Valley Museum", "lat": 46.455, "lon": 9.760, "category": "museum",
   "country": "Demo", "visited": True, "date_visited": "2024-07-13", "rating": 3},
  {"name": "Chapel of the Pass", "lat": 46.531, "lon": 9.905, "category": "religious",
   "country": "Demo", "visited": True, "date_visited": "2024-07-14", "rating": 5,
   "note": "Small stone chapel right on the ridge path."},
  {"name": "Hanging Falls", "lat": 46.430, "lon": 9.735, "category": "nature",
   "country": "Demo", "visited": True, "date_visited": "2023-09-10", "rating": 4},
  {"name": "Roman Bridge", "lat": 46.410, "lon": 9.680, "category": "ruins",
   "country": "Demo", "visited": True, "date_visited": "2023-09-11", "rating": 3},
  {"name": "Summit Cross", "lat": 46.560, "lon": 9.990, "category": "monument",
   "country": "Demo"},
  {"name": "High Garden", "lat": 46.478, "lon": 9.905, "category": "garden",
   "country": "Demo"},
  {"name": "Lakeside Palace", "lat": 46.445, "lon": 9.850, "category": "palace",
   "country": "Demo"},
]

CATEGORY_LABELS = {
  "castle": {"label": "Castles", "color": 0, "order": 0},
  "museum": {"label": "Museums", "color": 1, "order": 1},
  "religious": {"label": "Religious", "color": 2, "order": 2},
  "nature": {"label": "Nature", "color": 3, "order": 3},
  "ruins": {"label": "Ruins", "color": 4, "order": 4},
  "monument": {"label": "Monuments", "color": 5, "order": 5},
  "garden": {"label": "Gardens", "color": 6, "order": 6},
  "palace": {"label": "Palaces", "color": 7, "order": 7},
}


# --large only. A route here is drawn the same way as the ones above.
LARGE_ROUTES = [
  {
    "region": "Long Distance", "name": "Grand Traverse", "completed": True,
    "centre": (46.300, 9.300), "shape": "arc", "length_km": 72.0,
    "bearing": 60, "profile": lambda t: 700 + 1100 * math.sin(math.pi * t) ** 2 + 180 * math.sin(7 * math.pi * t),
    "meta": {"date_completed": "2022-08-20", "rating": 5, "difficulty": "hard",
             "tags": ["multi-day", "traverse"],
             "notes": "Four days hut to hut across the whole demo range."},
  },
  {
    "region": "Lowland Trails", "name": "Orchard Loop", "completed": True,
    "centre": (46.268, 9.555), "shape": "loop", "length_km": 6.0,
    "bearing": 0, "profile": lambda t: 640 + 40 * math.sin(2 * math.pi * t),
    "meta": {"date_completed": "2025-04-19", "rating": 3, "difficulty": "easy",
             "tags": ["loop"]},
  },
  {
    "region": "Demo Highlands", "name": "Glacier Approach", "completed": False,
    "centre": (46.600, 10.060), "shape": "out-and-back", "length_km": 13.0,
    "bearing": 150, "profile": lambda t: 1650 + 1100 * math.sin(math.pi * t) ** 1.2,
    "meta": {"difficulty": "hard", "tags": ["glacier"]},
  },
  {
    "region": "City Walks", "name": "Seven Hills Walk", "completed": True,
    "centre": (41.892, 12.487), "shape": "loop", "length_km": 8.0,
    "bearing": 0, "profile": lambda t: 35 + 25 * math.sin(6 * math.pi * t) ** 2,
    "meta": {"date_completed": "2024-04-27", "rating": 4, "difficulty": "easy",
             "tags": ["city", "loop"]},
  },
]

# --large only: invented places in real cities, so Visited countries shades
# some countries and leaves others as wishlist only.
ABROAD_PLACES = [
  {"name": "Forum Steps", "lat": 41.8925, "lon": 12.4853, "category": "ruins",
   "country": "Italy", "visited": True, "date_visited": "2024-04-26", "rating": 5},
  {"name": "Hilltop Basilica", "lat": 41.8986, "lon": 12.4769, "category": "religious",
   "country": "Italy", "visited": True, "date_visited": "2024-04-27", "rating": 4},
  {"name": "Tiber Gallery", "lat": 41.9060, "lon": 12.4820, "category": "museum",
   "country": "Italy", "visited": True, "date_visited": "2024-04-28", "rating": 3},
  {"name": "Orange Grove Garden", "lat": 41.8840, "lon": 12.4790, "category": "garden",
   "country": "Italy"},
  {"name": "River Palace", "lat": 48.8600, "lon": 2.3400, "category": "palace",
   "country": "France", "visited": True, "date_visited": "2022-10-03", "rating": 4},
  {"name": "Island Cathedral", "lat": 48.8530, "lon": 2.3500, "category": "religious",
   "country": "France", "visited": True, "date_visited": "2022-10-04", "rating": 5},
  {"name": "Harbour Fort", "lat": 38.6920, "lon": -9.2160, "category": "castle",
   "country": "Portugal", "visited": True, "date_visited": "2021-05-15", "rating": 4},
  {"name": "Gate Monument", "lat": 52.5163, "lon": 13.3777, "category": "monument",
   "country": "Germany", "visited": True, "date_visited": "2023-03-11", "rating": 3},
  {"name": "Mosaic Park", "lat": 41.4145, "lon": 2.1527, "category": "garden",
   "country": "Spain"},
  {"name": "Old Acropolis Hill", "lat": 37.9715, "lon": 23.7257, "category": "ruins",
   "country": "Greece"},
  {"name": "Summer Palace Gardens", "lat": 48.1850, "lon": 16.3120, "category": "palace",
   "country": "Austria"},
]

# --large only: sub-centres of the dense region as (lat, lon, spread in km,
# number of places). Tight blobs and loose ones, so the clusters split at
# different zoom levels.
DENSE_CENTRES = [
  (46.300, 9.560, 1.2, 40),
  (46.270, 9.520, 2.5, 30),
  (46.330, 9.640, 4.0, 30),
  (46.220, 9.620, 0.6, 20),
  (46.360, 9.480, 6.0, 30),
]
DENSE_WORDS = {
  "castle": ("Keep", "Tower", "Castle", "Fort"),
  "museum": ("Museum", "Gallery", "Archive", "Collection"),
  "religious": ("Chapel", "Church", "Shrine", "Abbey"),
  "nature": ("Falls", "Gorge", "Meadow", "Spring"),
  "ruins": ("Ruin", "Walls", "Old Mill", "Aqueduct"),
  "monument": ("Cross", "Obelisk", "Memorial", "Column"),
  "garden": ("Garden", "Orchard", "Arboretum", "Terrace"),
  "palace": ("Palace", "Manor", "Villa", "Hall"),
}
DENSE_ADJECTIVES = (
  "Upper", "Lower", "North", "South", "Old", "New", "Little", "Great",
  "Stone", "Green", "Hidden", "Quiet", "Windy", "Sunny", "High", "Red",
)


def dense_places(rng: random.Random) -> list[dict]:
  """About 150 invented places spread over DENSE_CENTRES, with names unique
  across the set and a mix of visited and wishlist in every category."""
  cats = list(DENSE_WORDS)
  out = []
  seen = {p["name"] for p in PLACES + ABROAD_PLACES}
  for lat0, lon0, spread_km, count in DENSE_CENTRES:
    for _ in range(count):
      i = len(out)
      cat = cats[i % len(cats)]
      noun = DENSE_WORDS[cat][(i // len(cats)) % len(DENSE_WORDS[cat])]
      adj = DENSE_ADJECTIVES[rng.randrange(len(DENSE_ADJECTIVES))]
      name = f"{adj} {noun}"
      n = 2
      while name in seen:
        name = f"{adj} {noun} {n}"
        n += 1
      seen.add(name)
      north = rng.gauss(0, spread_km * 1000)
      east = rng.gauss(0, spread_km * 1000)
      p = {"name": name,
           "lat": round(lat0 + north / M_PER_DEG, 5),
           "lon": round(lon0 + east / (M_PER_DEG * math.cos(math.radians(lat0))), 5),
           "category": cat, "country": "Demo"}
      if rng.random() < 0.45:
        p["visited"] = True
        p["date_visited"] = f"{rng.randint(2021, 2025)}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}"
        p["rating"] = rng.randint(1, 5)
      out.append(p)
  return out


def _ring(lat0: float, lon0: float, rx_km: float, ry_km: float, n: int = 16) -> list[list[float]]:
  """A closed [lon, lat] ellipse ring around a centre, rx east and ry north."""
  ring = []
  for i in range(n):
    a = 2 * math.pi * i / n
    lat = lat0 + ry_km * 1000 * math.sin(a) / M_PER_DEG
    lon = lon0 + rx_km * 1000 * math.cos(a) / (M_PER_DEG * math.cos(math.radians(lat0)))
    ring.append([round(lon, 5), round(lat, 5)])
  ring.append(ring[0])
  return ring


# --large only. Lake Basin holds Lake Loop, Old Watchtower and Lakeside
# Palace, so its popup has place and route counts to show.
AREAS = [
  {"name": "Lake Basin", "category": "park", "visited": True,
   "note": "Lake Loop and the tower above it.",
   "geometry": {"type": "Polygon", "coordinates": [_ring(46.472, 9.828, 4.0, 4.0)]}},
  {"name": "Glacier Reserve", "category": "nature-reserve", "visited": True,
   "geometry": {"type": "Polygon", "coordinates": [_ring(46.680, 10.180, 3.0, 2.0)]}},
  {"name": "Eastern Lakes", "category": "region",
   "geometry": {"type": "Polygon", "coordinates": [_ring(46.200, 10.300, 9.0, 6.0, 24)]}},
]


def _offsets(shape: str, length_m: float, n: int, rng: random.Random) -> list[tuple[float, float]]:
  """East/north offsets in metres from the centre for n+1 samples of a curve
  roughly length_m long, with a little seeded wobble so it reads as a trail."""
  pts = []
  for i in range(n + 1):
    t = i / n
    if shape == "loop":
      r = length_m / (2 * math.pi)
      a = 2 * math.pi * t
      x, y = r * math.cos(a) * 1.3, r * math.sin(a) * 0.8
    elif shape == "out-and-back":
      # Out along a gentle S, then back on a parallel line a few metres over.
      u = 1 - abs(2 * t - 1)
      side = 25 if t > 0.5 else 0
      x = u * length_m / 2
      y = 300 * math.sin(2 * math.pi * u) + side
    else:  # arc
      x = t * length_m * 0.9
      y = length_m * 0.18 * math.sin(math.pi * t)
    pts.append((x, y))
  # Smoothed random walk added on top, so the line is not a perfect curve.
  dx = dy = 0.0
  out = []
  for x, y in pts:
    dx = 0.9 * dx + rng.uniform(-6, 6)
    dy = 0.9 * dy + rng.uniform(-6, 6)
    out.append((x + dx, y + dy))
  return out


def route_gpx(route: dict, rng: random.Random) -> bytes:
  length_m = route["length_km"] * 1000
  n = int(length_m / 40)
  lat0, lon0 = route["centre"]
  b = math.radians(route["bearing"])
  lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    f'<gpx version="1.1" xmlns="{GPX_NS}">',
    f'  <trk><name>{escape(route["name"])}</name><trkseg>',
  ]
  for i, (x, y) in enumerate(_offsets(route["shape"], length_m, n, rng)):
    east = x * math.cos(b) + y * math.sin(b)
    north = -x * math.sin(b) + y * math.cos(b)
    lat = lat0 + north / M_PER_DEG
    lon = lon0 + east / (M_PER_DEG * math.cos(math.radians(lat0)))
    ele = route["profile"](i / n) + rng.uniform(-3, 3)
    lines.append(f'    <trkpt lat="{lat:.6f}" lon="{lon:.6f}"><ele>{ele:.1f}</ele></trkpt>')
  lines += ["  </trkseg></trk>", "</gpx>", ""]
  return "\n".join(lines).encode("utf-8")


def route_key(route: dict) -> str:
  return f"{route['region']}/{route['name']}"


def routes(large: bool = False) -> list[dict]:
  return ROUTES + LARGE_ROUTES if large else ROUTES


def places(large: bool = False) -> list[dict]:
  """The places for a set. The dense region draws from its own seed, and the
  large routes come after the default ones on the shared one, so the default
  set stays byte-identical to what it was before --large."""
  if not large:
    return PLACES
  return PLACES + ABROAD_PLACES + dense_places(random.Random(11))


def build(large: bool = False) -> dict[str, bytes]:
  """Archive name -> bytes for every file in the demo zip."""
  rng = random.Random(7)
  files: dict[str, bytes] = {}
  metadata = {}
  for route in routes(large):
    suffix = ".gpx" if route["completed"] else ".planned.gpx"
    files[f"gpx/{route['region']}/{route['name']}{suffix}"] = route_gpx(route, rng)
    metadata[route_key(route)] = route["meta"]

  def dump(obj) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

  files["places.json"] = dump(places(large))
  if large:
    files["areas.json"] = dump(AREAS)
  files["metadata.json"] = dump(metadata)
  files["category-labels.json"] = dump(CATEGORY_LABELS)
  return files


def build_zip(large: bool = False) -> bytes:
  buf = io.BytesIO()
  with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
    for name, data in sorted(build(large).items()):
      info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
      info.compress_type = zipfile.ZIP_DEFLATED
      zf.writestr(info, data)
  return buf.getvalue()


def main() -> int:
  ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
  ap.add_argument("-o", "--output", default="demo-data.zip", help="zip to write (default: %(default)s)")
  ap.add_argument("--large", action="store_true",
                  help="add a dense region, places abroad, areas and more routes, for a preview")
  args = ap.parse_args()
  Path(args.output).write_bytes(build_zip(args.large))
  print(f"wrote {args.output}", file=sys.stderr)
  return 0


if __name__ == "__main__":
  sys.exit(main())
