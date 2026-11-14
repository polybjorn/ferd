"""Route catalog entries that point at OpenStreetMap relations.

`catalog-routes.json` ships metadata only: a name, an OSM relation ID and the
same descriptive fields a place entry has. The geometry stays in OSM and is
fetched from Overpass when a user imports the entry, so the repo carries no
ODbL data and browsing the catalog sends no request anywhere.

An import walks the relation (and up to two levels of child relations, which
is how superroutes like the Tour du Mont Blanc are built), chains its ways in
member order, simplifies each line and writes a GPX that names OpenStreetMap
as the source and carries the ODbL licence in its metadata.
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

OSM_CREDIT = "OpenStreetMap contributors"
ODBL_URL = "https://opendatacommons.org/licenses/odbl/1-0/"

# Member roles that are not the main line: side trips, access paths and
# variants. Leaving them out keeps the import to one walkable line.
SKIP_ROLES = {"alternative", "excursion", "approach", "connection", "link", "variant"}

ROUTE_CATALOG_FIELDS = ["name", "relation", "country", "local_name", "note", "image", "sources"]
ROUTE_CATALOG_REQUIRED = {"name", "relation", "country"}


def relation_url(relation: int) -> str:
  return f"https://www.openstreetmap.org/relation/{relation}"


def _is_url(v: object) -> bool:
  if not isinstance(v, str):
    return False
  p = urlparse(v)
  return p.scheme in ("http", "https") and bool(p.netloc)


def validate_route_entry(e: object) -> dict:
  """Check one catalog-routes.json entry. Returns it unchanged; raises
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


def overpass_query(relation: int) -> str:
  """The relation and two levels of child relations, each with the geometry
  of its member ways, in member order."""
  return (f"[out:json][timeout:{OVERPASS_TIMEOUT_S - 10}];"
          f"relation({relation})->.r0;rel(r.r0)->.r1;rel(r.r1)->.r2;"
          "(.r0;.r1;.r2;);out geom;")


def fetch_overpass(relation: int, url: str = OVERPASS_URL) -> dict:
  """POST the relation query to Overpass and return the parsed answer.
  Raises ValidationError on a network error, a non-200 or a bad body."""
  data = urlencode({"data": overpass_query(relation)}).encode()
  req = urllib.request.Request(url, data=data, headers={"User-Agent": "Ferd route import (https://github.com/polybjorn/ferd)"})
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
