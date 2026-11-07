"""GPX parsing, PII stripping, moves and the GeoJSON export."""

from __future__ import annotations

import os
import sqlite3
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from . import store
from .common import ConflictError, NotFoundError, ValidationError, nfc_component, nfc_route_key, resolve_under, safe_path_component
from .routes import ROUTE_META_FIELDS
from .users import _walk_follow_symlinks


GPX_MAX_BYTES = 10 * 1024 * 1024  # 10 MiB cap for GPX uploads

GPX_NS = "http://www.topografix.com/GPX/1/1"


def parse_gpx_move(body: dict) -> dict:
  """Validate a /gpx/move body without touching the filesystem. Returns the
  parsed old/new region and name, both keys and whether the move changes
  nothing; raises ValidationError."""
  key = body.get("key") or ""
  new_region_raw = body.get("new_region")
  new_name_raw = body.get("new_name")
  if not isinstance(key, str) or not key:
    raise ValidationError("key required")
  if not isinstance(new_region_raw, str):
    raise ValidationError("new_region (string, may be empty) required")
  if new_name_raw is not None and not isinstance(new_name_raw, str):
    raise ValidationError("new_name must be a string if provided")
  parts = key.split("/")
  if len(parts) == 1:
    old_region, route_name = "", parts[0]
  elif len(parts) == 2:
    old_region, route_name = parts
  else:
    raise ValidationError(f"invalid key: {key}")
  if old_region:
    safe_path_component(old_region)
  safe_path_component(route_name)
  new_region = nfc_component(new_region_raw) if new_region_raw else ""
  final_name = nfc_component((new_name_raw or route_name).strip())
  return {
    "old_region": old_region, "route_name": route_name,
    "new_region": new_region, "final_name": final_name,
    "old_key": key,
    "new_key": f"{new_region}/{final_name}" if new_region else final_name,
    "noop": old_region == new_region and route_name == final_name,
  }


def plan_gpx_move(gpx_root: Path, req: dict) -> list:
  """The (src, dst) file pairs a parsed move renames: the walked and planned
  variants, whichever exist. Raises NotFoundError when neither does and
  ConflictError when a destination is taken."""
  src_dir = resolve_under(gpx_root, req["old_region"]) if req["old_region"] else resolve_under(gpx_root)
  dst_dir = resolve_under(gpx_root, req["new_region"]) if req["new_region"] else resolve_under(gpx_root)
  pairs = []
  for suffix in (".gpx", ".planned.gpx"):
    src = resolve_under(src_dir, f"{req['route_name']}{suffix}")
    dst = resolve_under(dst_dir, f"{req['final_name']}{suffix}")
    if src.is_file():
      pairs.append((src, dst))
  if not pairs:
    raise NotFoundError(f"route not found: {req['old_key']}")
  conflicts = [dst.name for src, dst in pairs if dst.exists() and dst != src]
  if conflicts:
    raise ConflictError(f"target already has: {', '.join(conflicts)}")
  return pairs


def apply_gpx_move(conn: sqlite3.Connection, uid: int, req: dict, pairs: list) -> int:
  """Rename the planned pairs, re-key the metadata entry and prune the old
  region dir if it emptied. Caller holds the .gpx.lock. Returns files moved."""
  if req["new_region"]:
    pairs[0][1].parent.mkdir(parents=True, exist_ok=True)
  moved = 0
  for src, dst in pairs:
    src.rename(dst)
    moved += 1
  store.rekey_metadata(conn, uid, {req["old_key"]: req["new_key"]})
  # Best-effort prune of an empty old region dir (no-region root never pruned).
  if req["old_region"]:
    src_dir = pairs[0][0].parent
    try:
      if not any(src_dir.iterdir()):
        src_dir.rmdir()
    except OSError:
      pass
  return moved


def _route_gone(gpx_root: Path, key: str) -> bool:
  """Whether the route `key` has no GPX file left. Only a missing region dir,
  or a readable one without either file, counts: an unreadable or dangling one
  says nothing, and a wrong yes deletes notes nothing else holds."""
  region, _, name = key.rpartition("/")
  try:
    folder = resolve_under(gpx_root, *region.split("/")) if region else gpx_root
  except ValidationError:
    return False
  # resolve_under follows links, so ask about the link itself.
  if not os.path.lexists(gpx_root.joinpath(*region.split("/")) if region else gpx_root):
    return True
  try:
    names = {nfc_route_key(n) for n in os.listdir(folder)}
  except OSError:
    return False
  return not {nfc_route_key(name + ".gpx"), nfc_route_key(name + ".planned.gpx")} & names


def prune_route_metadata(conn: sqlite3.Connection, uid: int, gpx_root: Path) -> int:
  """Tombstone the metadata of every route with no GPX file left, so a route
  uploaded later under the same name starts blank. Caller holds the .gpx.lock.
  Returns entries removed."""
  if not gpx_root.is_dir():
    return 0
  with store.transaction(conn):
    gone = [k for k in store.get_map(conn, uid, "metadata") if _route_gone(gpx_root, k)]
    return sum(store.delete_item(conn, uid, "metadata", k) is not None for k in gone)


# Real GPX stops around eight levels (gpx/trk/trkseg/trkpt/extensions/...).
# The cap keeps every recursive consumer of the tree, ET.tostring included,
# far from Python's recursion limit.
XML_MAX_DEPTH = 64


def _safe_xml_fromstring(xml_bytes: bytes):
  """Parse XML to an Element with internal DTD / entity declarations rejected
  at the expat layer. This blocks billion-laughs / quadratic-blowup XML bombs
  before any entity expansion happens. Raises ValidationError on parse error
  or on any DOCTYPE/entity declaration. Builds the tree directly via expat +
  ET.TreeBuilder because ET.XMLParser doesn't expose its expat parser on all
  supported Python versions."""
  from xml.parsers import expat
  builder = ET.TreeBuilder()
  parser = expat.ParserCreate(namespace_separator="}")
  depth = 0

  def _reject(*_a, **_kw):
    raise ValidationError("XML DOCTYPE or entity declarations are not allowed")

  def _start(name, attrs):
    nonlocal depth
    depth += 1
    if depth > XML_MAX_DEPTH:
      raise ValidationError(f"XML nested deeper than {XML_MAX_DEPTH} levels")
    # expat with namespace_separator="}" emits names as "URI}local"; ET wants
    # them as "{URI}local". Normalize on the fly. Same for attribute keys.
    if "}" in name:
      name = "{" + name
    fixed = {("{" + k) if "}" in k else k: v for k, v in attrs.items()}
    builder.start(name, fixed)

  def _end(name):
    nonlocal depth
    depth -= 1
    if "}" in name:
      name = "{" + name
    builder.end(name)

  parser.StartElementHandler = _start
  parser.EndElementHandler = _end
  parser.CharacterDataHandler = builder.data
  parser.EntityDeclHandler = _reject
  parser.UnparsedEntityDeclHandler = _reject
  parser.StartDoctypeDeclHandler = _reject
  parser.ExternalEntityRefHandler = lambda *_a, **_kw: False

  try:
    parser.Parse(xml_bytes, True)
  except expat.ExpatError as e:
    raise ValidationError(f"not valid XML: {e}")
  return builder.close()


def validate_gpx(xml_bytes: bytes) -> None:
  """Parse to confirm well-formed XML with a <gpx> root. Does not modify."""
  root = _safe_xml_fromstring(xml_bytes)
  root_tag = root.tag.split("}", 1)[-1] if "}" in root.tag else root.tag
  if root_tag != "gpx":
    raise ValidationError(f"root element must be <gpx>, got <{root_tag}>")


def strip_gpx_pii(xml_bytes: bytes) -> bytes:
  """Parse GPX, drop <time>/<author> elements and creator= attribute, re-serialize.

  Raises ValidationError if the bytes aren't a valid GPX document.
  """
  for prefix, uri in (
    ("", GPX_NS),
    ("gpx_style", "http://www.topografix.com/GPX/gpx_style/0/2"),
    ("gpxtpx", "http://www.garmin.com/xmlschemas/TrackPointExtension/v1"),
    ("gpxx", "http://www.garmin.com/xmlschemas/GpxExtensions/v3"),
    ("gpxpx", "http://www.garmin.com/xmlschemas/PowerExtension/v1"),
    ("xsi", "http://www.w3.org/2001/XMLSchema-instance"),
  ):
    ET.register_namespace(prefix, uri)
  root = _safe_xml_fromstring(xml_bytes)
  root_tag = root.tag.split("}", 1)[-1] if "}" in root.tag else root.tag
  if root_tag != "gpx":
    raise ValidationError(f"root element must be <gpx>, got <{root_tag}>")

  def walk(parent):
    to_remove = []
    for child in parent:
      tag = child.tag.split("}", 1)[-1] if "}" in child.tag else child.tag
      if tag in ("time", "author"):
        to_remove.append(child)
      else:
        walk(child)
    for el in to_remove:
      parent.remove(el)

  if "creator" in root.attrib:
    del root.attrib["creator"]
  walk(root)
  return ET.tostring(root, xml_declaration=True, encoding="UTF-8")


def _gpx_position(el) -> list | None:
  """[lon, lat] or [lon, lat, ele] from a <trkpt>/<rtept>, or None when the
  point has no usable coordinates. Nothing else on the point (time, extensions)
  is read, so the output carries only geometry."""
  try:
    lat = float(el.attrib["lat"])
    lon = float(el.attrib["lon"])
  except (KeyError, ValueError):
    return None
  if not (-180 <= lon <= 180 and -90 <= lat <= 90):
    return None
  pos = [round(lon, 6), round(lat, 6)]
  for child in el:
    if child.tag.rsplit("}", 1)[-1] == "ele" and child.text:
      try:
        pos.append(round(float(child.text), 1))
      except ValueError:
        pass
      break
  return pos


def gpx_lines(xml_bytes: bytes) -> list[list[list]]:
  """Every track segment and route in a GPX file as a list of positions, at
  full resolution. Lines with fewer than two points are dropped."""
  root = _safe_xml_fromstring(xml_bytes)
  lines = []
  for el in root.iter():
    tag = el.tag.rsplit("}", 1)[-1]
    if tag not in ("trkseg", "rte"):
      continue
    point_tag = "trkpt" if tag == "trkseg" else "rtept"
    line = []
    for pt in el:
      if pt.tag.rsplit("}", 1)[-1] == point_tag:
        pos = _gpx_position(pt)
        if pos is not None:
          line.append(pos)
    if len(line) >= 2:
      lines.append(line)
  return lines


def _route_files(gpx_root: Path) -> dict[str, dict]:
  """Route key ("region/name", or "name" with no region) -> {region, name,
  path, completed}, preferring the walked file over a planned one, the same
  pairing gpx-manifest.sh writes to routes.json."""
  routes: dict[str, dict] = {}
  for root, files in _walk_follow_symlinks(gpx_root):
    region = Path(root).relative_to(gpx_root).as_posix()
    region = "" if region == "." else region
    for fname in sorted(files):
      if fname.startswith(".") or not fname.endswith(".gpx"):
        continue
      planned = fname.endswith(".planned.gpx")
      name = fname[:-len(".planned.gpx")] if planned else fname[:-len(".gpx")]
      key = f"{region}/{name}" if region else name
      if key in routes and not planned and routes[key]["completed"] is False:
        del routes[key]
      if key not in routes:
        routes[key] = {"region": region, "name": name, "path": Path(root) / fname, "completed": not planned}
  return routes


def build_geojson(udir: Path, places: list, areas: list, metadata: dict) -> dict:
  """A FeatureCollection of a user's places (Point), areas (Polygon or
  MultiPolygon) and routes (LineString or MultiLineString). Places, areas and
  route metadata come in as rows; routes are the GPX files under `udir`. Every feature has
  a `kind` and a `name` property; the rest are the stored fields. Route
  geometry is coordinates and elevation only, so GPX timestamps, author and
  creator never reach the output."""
  features = []
  for p in places:
    if not isinstance(p, dict):
      continue
    lat, lon = p.get("lat"), p.get("lon")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (lat, lon)):
      continue
    props = {"kind": "place"}
    props.update((k, v) for k, v in p.items() if k not in ("lat", "lon"))
    features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": props})

  for a in areas:
    if not isinstance(a, dict) or not isinstance(a.get("geometry"), dict):
      continue
    props = {"kind": "area"}
    props.update((k, v) for k, v in a.items() if k != "geometry")
    features.append({"type": "Feature", "geometry": a["geometry"], "properties": props})

  for key, r in sorted(_route_files(udir / "gpx").items()):
    try:
      lines = gpx_lines(r["path"].read_bytes())
    except (OSError, ValidationError) as e:
      print(f"[api] geojson: skipping {r['path']}: {e}", file=sys.stderr)
      continue
    if not lines:
      continue
    geometry = ({"type": "LineString", "coordinates": lines[0]} if len(lines) == 1
                else {"type": "MultiLineString", "coordinates": lines})
    props = {"kind": "route", "name": r["name"], "region": r["region"], "completed": r["completed"]}
    meta = metadata.get(key)
    if isinstance(meta, dict):
      props.update((k, v) for k, v in meta.items() if k in ROUTE_META_FIELDS)
    features.append({"type": "Feature", "geometry": geometry, "properties": props})
  return {"type": "FeatureCollection", "features": features}
