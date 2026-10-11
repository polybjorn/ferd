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

Usage: python3 scripts/demo-data.py [-o demo-data.zip]

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


def build() -> dict[str, bytes]:
  """Archive name -> bytes for every file in the demo zip."""
  rng = random.Random(7)
  files: dict[str, bytes] = {}
  metadata = {}
  for route in ROUTES:
    suffix = ".gpx" if route["completed"] else ".planned.gpx"
    files[f"gpx/{route['region']}/{route['name']}{suffix}"] = route_gpx(route, rng)
    metadata[route_key(route)] = route["meta"]

  def dump(obj) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

  files["places.json"] = dump(PLACES)
  files["metadata.json"] = dump(metadata)
  files["category-labels.json"] = dump(CATEGORY_LABELS)
  return files


def build_zip() -> bytes:
  buf = io.BytesIO()
  with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
    for name, data in sorted(build().items()):
      info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
      info.compress_type = zipfile.ZIP_DEFLATED
      zf.writestr(info, data)
  return buf.getvalue()


def main() -> int:
  ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
  ap.add_argument("-o", "--output", default="demo-data.zip", help="zip to write (default: %(default)s)")
  args = ap.parse_args()
  Path(args.output).write_bytes(build_zip())
  print(f"wrote {args.output}", file=sys.stderr)
  return 0


if __name__ == "__main__":
  sys.exit(main())
