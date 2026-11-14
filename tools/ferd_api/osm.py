"""Route and area catalog entries that point at OpenStreetMap relations.

`catalog-routes.json` ships metadata only: a name, an OSM relation ID and the
same descriptive fields a place entry has. The geometry stays in OSM and is
fetched from Overpass when a user imports the entry, so the repo carries no
ODbL data and browsing the catalog sends no request anywhere.

An import walks the relation (and up to two levels of child relations, which
is how superroutes like the Tour du Mont Blanc are built), chains its ways in
member order, simplifies each line and writes a GPX that names OpenStreetMap
as the source and carries the ODbL licence in its metadata.

An area import (`catalog-areas.json`) fetches the relation's outer and inner
ways, closes them into rings, puts each inner ring in the outer that holds it
and answers a GeoJSON Polygon or MultiPolygon, simplified the same way.
"""

from __future__ import annotations

import json
import math
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import urlencode, urlparse

from .common import ValidationError
from .gpx import GPX_NS

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_TIMEOUT_S = 90
# Overpass answers for a long superroute run to tens of MB; anything past this
# is refused rather than parsed.
OVERPASS_MAX_BYTES = 64 * 1024 * 1024

# Points kept across every line of one imported route. The tolerance below
# starts at SIMPLIFY_START_M and doubles until the route fits.
ROUTE_MAX_POINTS = 8000
SIMPLIFY_START_M = 5.0
SIMPLIFY_MAX_M = 640.0

# Points kept across every ring of one imported area: the same budget the
# app's own boundary import simplifies to (AREA_TARGET_POINTS in area-geo.js).
AREA_MAX_POINTS = 5000

OSM_CREDIT = "OpenStreetMap contributors"
ODBL_URL = "https://opendatacommons.org/licenses/odbl/1-0/"

# Member roles that are not the main line: side trips, access paths and
# variants. Leaving them out keeps the import to one walkable line.
SKIP_ROLES = {"alternative", "excursion", "approach", "connection", "link", "variant"}

ROUTE_CATALOG_FIELDS = ["name", "relation", "country", "local_name", "note", "image", "sources"]
ROUTE_CATALOG_REQUIRED = {"name", "relation", "country"}
# catalog-areas.json entries take the same fields.
AREA_CATALOG_FIELDS = ROUTE_CATALOG_FIELDS


def relation_url(relation: int) -> str:
  return f"https://www.openstreetmap.org/relation/{relation}"


def _is_url(v: object) -> bool:
  if not isinstance(v, str):
    return False
  p = urlparse(v)
  return p.scheme in ("http", "https") and bool(p.netloc)


def validate_route_entry(e: object) -> dict:
  """Check one catalog-routes.json or catalog-areas.json entry. Returns it unchanged; raises
  ValidationError naming the first problem."""
  if not isinstance(e, dict):
    raise ValidationError("entry must be an object")
  unknown = set(e) - set(ROUTE_CATALOG_FIELDS)
  if unknown:
    raise ValidationError(f"unknown fields: {sorted(unknown)}")
  missing = ROUTE_CATALOG_REQUIRED - set(e)
  if missing:
    raise ValidationError(f"missing fields: {sorted(missing)}")
  for key in ("name", "country", "local_name", "note"):
    if key in e and (not isinstance(e[key], str) or not e[key].strip() or len(e[key]) > 200):
      raise ValidationError(f"{key} must be a non-empty string (max 200 chars)")
  rel = e["relation"]
  if not isinstance(rel, int) or isinstance(rel, bool) or rel <= 0:
    raise ValidationError("relation must be a positive integer")
  if "image" in e and not _is_url(e["image"]):
    raise ValidationError("image must be an http or https URL")
  if "sources" in e:
    if not isinstance(e["sources"], list) or not e["sources"] or not all(_is_url(s) for s in e["sources"]):
      raise ValidationError("sources must be a non-empty list of http or https URLs")
  return e


validate_area_entry = validate_route_entry


def overpass_query(relation: int) -> str:
  """The relation and two levels of child relations, each with the geometry
  of its member ways, in member order."""
  return (f"[out:json][timeout:{OVERPASS_TIMEOUT_S - 10}];"
          f"relation({relation})->.r0;rel(r.r0)->.r1;rel(r.r1)->.r2;"
          "(.r0;.r1;.r2;);out geom;")


def area_query(relation: int) -> str:
  """The relation alone, with the geometry of its member ways. A boundary's
  child relations (subareas) are other areas, so they are not fetched."""
  return f"[out:json][timeout:{OVERPASS_TIMEOUT_S - 10}];relation({relation});out geom;"


def fetch_overpass(relation: int, url: str = OVERPASS_URL, query=overpass_query) -> dict:
  """POST `query(relation)` to Overpass and return the parsed answer.
  Raises ValidationError on a network error, a non-200 or a bad body."""
  data = urlencode({"data": query(relation)}).encode()
  req = urllib.request.Request(url, data=data, headers={"User-Agent": "Ferd catalog import (https://github.com/polybjorn/ferd)"})
  try:
    with urllib.request.urlopen(req, timeout=OVERPASS_TIMEOUT_S) as resp:
      body = resp.read(OVERPASS_MAX_BYTES + 1)
  except urllib.error.HTTPError as e:
    raise ValidationError(f"Overpass answered HTTP {e.code}")
  except (urllib.error.URLError, OSError) as e:
    raise ValidationError(f"Overpass unreachable: {e}")
  if len(body) > OVERPASS_MAX_BYTES:
    raise ValidationError("Overpass answer too large")
  try:
    return json.loads(body)
  except ValueError:
    raise ValidationError("Overpass answer is not JSON")


def _member_ways(rel_id: int, rels: dict, seen: set) -> list:
  """The member ways' coordinate lists of `rel_id`, child relations expanded
  in place, skipped roles left out."""
  rel = rels.get(rel_id)
  if rel is None or rel_id in seen:
    return []
  seen.add(rel_id)
  out = []
  for m in rel.get("members") or []:
    if (m.get("role") or "") in SKIP_ROLES:
      continue
    if m.get("type") == "way":
      pts = [(p["lat"], p["lon"]) for p in (m.get("geometry") or []) if isinstance(p, dict) and "lat" in p and "lon" in p]
      if len(pts) >= 2:
        out.append(pts)
    elif m.get("type") == "relation":
      out.extend(_member_ways(m.get("ref"), rels, seen))
  return out


def chain_ways(ways: list) -> list:
  """Join ways that share an end point into lines, in the order given. A way
  that does not touch the line so far starts a new one."""
  lines: list = []
  cur: list = []
  single = False  # cur is one way so far, so its direction is still open
  for w in ways:
    if not cur:
      cur, single = list(w), True
      continue
    if cur[-1] == w[0]:
      cur.extend(w[1:])
    elif cur[-1] == w[-1]:
      cur.extend(reversed(w[:-1]))
    elif single and cur[0] == w[0]:
      cur.reverse()
      cur.extend(w[1:])
    elif single and cur[0] == w[-1]:
      cur.reverse()
      cur.extend(reversed(w[:-1]))
    else:
      lines.append(cur)
      cur, single = list(w), True
      continue
    single = False
  if cur:
    lines.append(cur)
  return lines


def simplify(line: list, tol_m: float) -> list:
  """Douglas-Peucker on (lat, lon) points, distances in metres on a local
  equirectangular projection. Iterative, so a long line cannot hit the
  recursion limit."""
  if len(line) < 3:
    return list(line)
  lat0 = math.radians(sum(p[0] for p in line) / len(line))
  kx, ky = 111320.0 * math.cos(lat0), 110540.0
  xy = [(p[1] * kx, p[0] * ky) for p in line]
  keep = [False] * len(line)
  keep[0] = keep[-1] = True
  stack = [(0, len(line) - 1)]
  tol2 = tol_m * tol_m
  while stack:
    a, b = stack.pop()
    ax, ay = xy[a]
    bx, by = xy[b]
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    best, best_i = -1.0, -1
    for i in range(a + 1, b):
      px, py = xy[i]
      if seg2 == 0:
        d2 = (px - ax) ** 2 + (py - ay) ** 2
      else:
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
      if d2 > best:
        best, best_i = d2, i
    if best > tol2:
      keep[best_i] = True
      stack.append((a, best_i))
      stack.append((best_i, b))
  return [p for p, k in zip(line, keep) if k]


def simplify_to_fit(lines: list, max_points: int = ROUTE_MAX_POINTS) -> tuple[list, float]:
  """Simplify every line at the smallest tolerance, doubling from
  SIMPLIFY_START_M, that brings the total under max_points. Returns the lines
  and the tolerance used."""
  tol = SIMPLIFY_START_M
  while True:
    out = [s for s in (simplify(l, tol) for l in lines) if len(s) >= 2]
    if sum(len(l) for l in out) <= max_points or tol >= SIMPLIFY_MAX_M:
      return out, tol
    tol *= 2


def relation_lines(answer: dict, relation: int) -> list:
  """The chained lines of `relation` from an Overpass answer."""
  rels = {e["id"]: e for e in (answer.get("elements") or [])
          if isinstance(e, dict) and e.get("type") == "relation" and isinstance(e.get("id"), int)}
  if relation not in rels:
    raise ValidationError(f"relation {relation} not found in OpenStreetMap")
  lines = chain_ways(_member_ways(relation, rels, set()))
  if not lines:
    raise ValidationError(f"relation {relation} has no way geometry")
  return lines


_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def build_gpx(name: str, relation: int, lines: list) -> bytes:
  """A GPX 1.1 track of `lines`, one segment each, with OpenStreetMap named in
  the metadata copyright and a link to the relation."""
  ET.register_namespace("", GPX_NS)
  ns = "{" + GPX_NS + "}"
  root = ET.Element(ns + "gpx", {"version": "1.1", "creator": "Ferd"})
  meta = ET.SubElement(root, ns + "metadata")
  ET.SubElement(meta, ns + "name").text = _CONTROL_RE.sub("", name)
  cr = ET.SubElement(meta, ns + "copyright", {"author": OSM_CREDIT})
  ET.SubElement(cr, ns + "license").text = ODBL_URL
  link = ET.SubElement(meta, ns + "link", {"href": relation_url(relation)})
  ET.SubElement(link, ns + "text").text = f"OpenStreetMap relation {relation}"
  trk = ET.SubElement(root, ns + "trk")
  ET.SubElement(trk, ns + "name").text = _CONTROL_RE.sub("", name)
  for line in lines:
    seg = ET.SubElement(trk, ns + "trkseg")
    for lat, lon in line:
      ET.SubElement(seg, ns + "trkpt", {"lat": f"{lat:.6f}", "lon": f"{lon:.6f}"})
  return ET.tostring(root, xml_declaration=True, encoding="UTF-8")


def import_route(entry: dict, fetch=fetch_overpass) -> dict:
  """Fetch, chain and simplify one catalog entry's relation. Returns the GPX
  text and what was kept, for the client to store as an upload."""
  relation = entry["relation"]
  lines, tol = simplify_to_fit(relation_lines(fetch(relation), relation))
  return {
    "gpx": build_gpx(entry["name"], relation, lines).decode("utf-8"),
    "points": sum(len(l) for l in lines),
    "segments": len(lines),
    "tolerance_m": tol,
    "source": relation_url(relation),
    "credit": f"Route data (c) {OSM_CREDIT}, ODbL",
  }


def _way_points(m: dict) -> list:
  return [(p["lat"], p["lon"]) for p in (m.get("geometry") or []) if isinstance(p, dict) and "lat" in p and "lon" in p]


def close_rings(ways: list) -> list:
  """Join ways into closed rings. Multipolygon members come in no set order
  or direction, so each ring grows by whichever way shares its open end. A
  ring that cannot be closed is a broken relation and is left out."""
  pool = [list(w) for w in ways if len(w) >= 2]
  rings = []
  while pool:
    ring = pool.pop(0)
    while ring[0] != ring[-1]:
      for i, w in enumerate(pool):
        if w[0] == ring[-1]:
          ring.extend(w[1:])
        elif w[-1] == ring[-1]:
          ring.extend(reversed(w[:-1]))
        else:
          continue
        pool.pop(i)
        break
      else:
        break
    if ring[0] == ring[-1] and len(ring) >= 4:
      rings.append(ring)
  return rings


def _in_ring(pt: tuple, ring: list) -> bool:
  """Ray casting on (lat, lon); fine at the scale of one area."""
  y, x = pt
  inside = False
  for (y1, x1), (y2, x2) in zip(ring, ring[1:]):
    if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
      inside = not inside
  return inside


def relation_polygons(answer: dict, relation: int) -> list:
  """The polygons of a multipolygon or boundary relation from an Overpass
  answer: a list of [outer, inner, ...] rings of (lat, lon). A member with no
  role counts as outer, as older boundaries tag them; any other role (a
  label node, a subarea) is not part of the outline."""
  rel = next((e for e in (answer.get("elements") or [])
              if isinstance(e, dict) and e.get("type") == "relation" and e.get("id") == relation), None)
  if rel is None:
    raise ValidationError(f"relation {relation} not found in OpenStreetMap")
  outer, inner = [], []
  for m in rel.get("members") or []:
    if m.get("type") != "way":
      continue
    role = m.get("role") or ""
    if role in ("", "outer"):
      outer.append(_way_points(m))
    elif role == "inner":
      inner.append(_way_points(m))
  polygons = [[r] for r in close_rings(outer)]
  if not polygons:
    raise ValidationError(f"relation {relation} has no closed outline")
  for hole in close_rings(inner):
    home = next((p for p in polygons if _in_ring(hole[0], p[0])), None)
    if home is not None:
      home.append(hole)
  return polygons


def simplify_polygons_to_fit(polygons: list, max_points: int = AREA_MAX_POINTS) -> tuple[list, float]:
  """Simplify every ring at the smallest tolerance, doubling from
  SIMPLIFY_START_M, that brings the total under max_points. A ring that
  falls under four points is dropped, and a polygon with it when it was the
  outline, so small islands go first as the tolerance grows."""
  tol = SIMPLIFY_START_M
  while True:
    out = []
    for rings in polygons:
      kept = [s for s in (simplify(r, tol) for r in rings[1:]) if len(s) >= 4]
      outline = simplify(rings[0], tol)
      if len(outline) >= 4:
        out.append([outline] + kept)
    if not out:
      raise ValidationError("the area is too small to keep after simplification")
    if sum(len(r) for p in out for r in p) <= max_points or tol >= SIMPLIFY_MAX_M:
      return out, tol
    tol *= 2


def build_area_geometry(polygons: list) -> dict:
  """GeoJSON ([lon, lat]) Polygon for one polygon, MultiPolygon for more."""
  coords = [[[[round(lon, 6), round(lat, 6)] for lat, lon in ring] for ring in rings] for rings in polygons]
  if len(coords) == 1:
    return {"type": "Polygon", "coordinates": coords[0]}
  return {"type": "MultiPolygon", "coordinates": coords}


def import_area(entry: dict, fetch=None) -> dict:
  """Fetch, assemble and simplify one area catalog entry's relation. Returns
  the geometry and what was kept, for the client to store as an area."""
  relation = entry["relation"]
  if fetch is None:
    fetch = lambda rel: fetch_overpass(rel, query=area_query)  # noqa: E731
  polygons, tol = simplify_polygons_to_fit(relation_polygons(fetch(relation), relation))
  return {
    "geometry": build_area_geometry(polygons),
    "points": sum(len(r) for p in polygons for r in p),
    "polygons": len(polygons),
    "tolerance_m": tol,
    "source": relation_url(relation),
    "credit": f"Area data (c) {OSM_CREDIT}, ODbL",
  }
