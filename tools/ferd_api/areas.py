"""Area (polygon) validation."""

from __future__ import annotations

from .common import ValidationError, _OMIT
from .places import PLACE_DEFAULTS, PLACE_FIELDS


AREA_REQUIRED = {"name", "geometry"}

# The frontend simplifies an import to well under this; the cap holds a direct
# API write inside the default max_body_bytes.
AREA_MAX_POINTS = 20000


def _area_source(key: str, value: object) -> str:
  """A closed set, since the app turns it into a credit on public maps."""
  if value != "osm":
    raise ValidationError(f"{key} must be \"osm\"")
  return value


AREA_FIELDS = {key: PLACE_FIELDS[key] for key in ("visited", "id", "category", "note", "local_name")}

AREA_FIELDS["source"] = _area_source

AREA_ALL = AREA_REQUIRED | set(AREA_FIELDS)


def _area_position(pos: object) -> list:
  """Check one GeoJSON position and return it as [lon, lat], dropping any
  altitude. A projected file lands here with coordinates in the hundreds of
  thousands, so the message names the likely cause."""
  if not isinstance(pos, list) or len(pos) < 2:
    raise ValidationError("geometry positions must be [lon, lat] arrays")
  lon, lat = pos[0], pos[1]
  for v in (lon, lat):
    if not isinstance(v, (int, float)) or isinstance(v, bool):
      raise ValidationError("geometry coordinates must be numbers")
  if not (-180 <= lon <= 180 and -90 <= lat <= 90):
    raise ValidationError(
      "coordinates are outside the lon/lat range, so the file is probably in a "
      "projected system such as UTM33 (EPSG:25833); reproject it to WGS84"
    )
  return [lon, lat]


def validate_area_geometry(g: object) -> dict:
  """Validate a GeoJSON Polygon or MultiPolygon and return a 2D copy."""
  if not isinstance(g, dict) or g.get("type") not in ("Polygon", "MultiPolygon"):
    raise ValidationError("geometry must be a GeoJSON Polygon or MultiPolygon")
  kind = g["type"]
  coords = g.get("coordinates")
  polygons = [coords] if kind == "Polygon" else coords
  if not isinstance(polygons, list) or not polygons:
    raise ValidationError("geometry has no coordinates")
  total = 0
  out = []
  for polygon in polygons:
    if not isinstance(polygon, list) or not polygon:
      raise ValidationError("geometry has an empty polygon")
    rings = []
    for ring in polygon:
      if not isinstance(ring, list) or len(ring) < 4:
        raise ValidationError("each geometry ring needs at least 4 positions")
      total += len(ring)
      if total > AREA_MAX_POINTS:
        raise ValidationError(f"geometry has more than {AREA_MAX_POINTS} points")
      clean = [_area_position(pos) for pos in ring]
      if clean[0] != clean[-1]:
        raise ValidationError("geometry rings must be closed")
      rings.append(clean)
    out.append(rings)
  return {"type": kind, "coordinates": out[0] if kind == "Polygon" else out}


def validate_area(a: object) -> dict:
  """Validate an area and return the normalized copy that gets stored."""
  if not isinstance(a, dict):
    raise ValidationError("area must be an object")
  extra = set(a) - AREA_ALL
  if extra:
    raise ValidationError(f"unknown fields: {sorted(extra)}")
  missing = AREA_REQUIRED - set(a)
  if missing:
    raise ValidationError(f"missing required fields: {sorted(missing)}")
  name = a["name"]
  if not isinstance(name, str) or not name.strip() or len(name) > 200:
    raise ValidationError("name must be a non-empty string (<=200 chars)")
  out = {"name": name.strip(), "geometry": validate_area_geometry(a["geometry"])}
  for key, check in AREA_FIELDS.items():
    value = check(key, a[key]) if key in a else PLACE_DEFAULTS.get(key, _OMIT)
    if value is not _OMIT:
      out[key] = value
  return out
