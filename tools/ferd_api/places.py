"""Place validation, country-name lookup and country-code backfill."""

from __future__ import annotations

import json
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path
from urllib.parse import urlparse

from .common import ValidationError, _OMIT, _check_date, _check_rating, normalize_tags
from .store import put_item, transaction


PLACE_REQUIRED = {"name", "lat", "lon"}

PLACE_ID_RE = re.compile(r"^[0-9a-f]{8}$")


def _place_text(max_len: int):
  """Spec for an optional free-text field: null drops it, "" is kept."""
  def check(key: str, v: object):
    if v is None:
      return _OMIT
    if not isinstance(v, str) or len(v) > max_len:
      raise ValidationError(f"{key} must be a string (<={max_len} chars) or null")
    return v.strip()
  return check


def _place_id(key: str, v: object):
  # `id` is a server-assigned per-row identifier (8-char hex). On create the
  # client never sets it; on update the client echoes back what GET returned.
  if v is None or v == "":
    return _OMIT
  if not isinstance(v, str) or not PLACE_ID_RE.match(v):
    raise ValidationError("id must be an 8-char hex string")
  return v


def _place_visited(key: str, v: object):
  if not isinstance(v, bool):
    raise ValidationError("visited must be boolean")
  return v


def _place_category(key: str, v: object):
  # An empty string or missing field both mean "uncategorized" and are
  # stripped from the stored object.
  if v is None or v == "":
    return _OMIT
  if not isinstance(v, str) or not v.strip() or len(v) > 64:
    raise ValidationError("category, when set, must be a non-empty string (<=64 chars)")
  return v.strip()


def _place_sources(key: str, v: object):
  if not isinstance(v, list) or len(v) > 20:
    raise ValidationError("sources must be a list (<=20 items)")
  for s in v:
    if not isinstance(s, str) or len(s) > 500:
      raise ValidationError("each source must be a string (<=500 chars)")
    if urlparse(s).scheme.lower() not in ("http", "https"):
      raise ValidationError("each source must be an http(s) URL")
  return v


def _place_image(key: str, v: object):
  if v is None:
    return _OMIT
  if v == "":
    return v
  if not isinstance(v, str) or len(v) > 1000:
    raise ValidationError("image must be a string (<=1000 chars) or null")
  if urlparse(v).scheme.lower() not in ("http", "https"):
    raise ValidationError("image must be an http(s) URL")
  return v.strip()


def _place_image_focus(key: str, v: object):
  if v is None:
    return _OMIT
  if not isinstance(v, str):
    raise ValidationError("image_focus must be a string")
  stripped = v.strip()
  if not stripped:
    return _OMIT
  if not re.match(r"^(top|bottom|center|left|right|\d{1,3}%\s+\d{1,3}%)$", stripped):
    raise ValidationError("image_focus must be one of top/bottom/center/left/right or 'N% N%'")
  return stripped


def _place_date_visited(key: str, v: object):
  if v is None or v == "":
    return _OMIT
  _check_date(v, key)
  return v


def _place_rating(key: str, v: object):
  if v is None or v == "":
    return _OMIT
  _check_rating(v)
  return v


def _place_catalog_skip(key: str, v: object):
  # Catalog-tracked fields the user has opted out of for this place, mapped to
  # the catalog value at the time of opt-out. Used to suppress "Update
  # available" for diffs the user has already considered; if the catalog value
  # later changes, the field reappears as a new update.
  if v is None:
    return _OMIT
  if not isinstance(v, dict) or len(v) > 20:
    raise ValidationError("catalog_skip must be an object (<=20 entries)")
  for k, val in v.items():
    if not isinstance(k, str) or not k or len(k) > 64:
      raise ValidationError("catalog_skip keys must be non-empty strings (<=64 chars)")
    if val is not None and not isinstance(val, (str, int, float, bool, list)):
      raise ValidationError("catalog_skip values must be JSON scalars or lists")
    if isinstance(val, list):
      if len(val) > 50:
        raise ValidationError("catalog_skip list values capped at 50 items")
      for item in val:
        if not isinstance(item, (str, int, float, bool)) or (isinstance(item, str) and len(item) > 500):
          raise ValidationError("catalog_skip list items must be JSON scalars (strings <=500 chars)")
  return v or _OMIT


def _place_tags(key: str, v: object):
  # Free-form labels (e.g. "unesco"), same format/cap as route tags.
  if not v:
    return _OMIT
  return normalize_tags(v) or _OMIT


# Country name -> ISO 3166-1 alpha-2 code, built by scripts/build-countries.py
# from Natural Earth plus common aliases. Loaded on first use; a missing file
# leaves every place without a code rather than failing the write.
COUNTRY_NAMES_PATH = Path(__file__).resolve().parent.parent.parent / "vendor" / "natural-earth" / "country-names.json"

_country_names: dict | None = None


def normalise_country_name(name: str) -> str:
  """Fold case, accents and punctuation. Must match norm() in
  scripts/build-countries.py and normCountryName in app/countries.js."""
  s = unicodedata.normalize("NFKD", name)
  s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
  s = s.replace("&", " and ").replace(".", "").replace("'", "").replace("\u2019", "")
  s = " ".join(s.replace(",", " ").split())
  if s.startswith("the "):
    s = s[4:]
  return s


def country_names() -> dict:
  global _country_names
  if _country_names is None:
    try:
      data = json.loads(COUNTRY_NAMES_PATH.read_text("utf-8"))
      _country_names = data if isinstance(data, dict) else {}
    except (OSError, ValueError) as e:
      print(f"[api] country codes unavailable: {e}", file=sys.stderr)
      _country_names = {}
  return _country_names


def country_code_for(name: object) -> str | None:
  """The ISO code for a free-text country, or None when it does not match.
  Never guesses: an unknown name stays without a code."""
  if not isinstance(name, str) or not name.strip():
    return None
  return country_names().get(normalise_country_name(name))


def _place_country_code(key: str, v: object):
  # Derived from `country` in validate_place; a client copy is accepted so a
  # round-tripped place validates, then replaced.
  if v is not None and (not isinstance(v, str) or len(v) > 8):
    raise ValidationError("country_code must be a short string or null")
  return _OMIT


# One spec per optional place field: check(key, value) raises ValidationError
# or returns the value to store, or _OMIT to leave the field out. Order is the
# order fields are checked and the key order written to places.json.
PLACE_FIELDS = {
  "visited": _place_visited,
  "id": _place_id,
  "category": _place_category,
  "country": _place_text(100),
  "country_code": _place_country_code,
  "note": _place_text(2000),
  "local_name": _place_text(200),
  "sources": _place_sources,
  "image": _place_image,
  # Name of the catalog entry this place was imported from; the UI uses it to
  # hide already-imported entries in Browse and to offer "Update from catalog"
  # when the upstream entry diverges.
  "from_catalog": _place_text(200),
  "image_focus": _place_image_focus,
  "date_visited": _place_date_visited,
  "rating": _place_rating,
  "catalog_skip": _place_catalog_skip,
  "tags": _place_tags,
}

PLACE_DEFAULTS = {"visited": False}

PLACE_OPTIONAL = set(PLACE_FIELDS)

PLACE_ALL = PLACE_REQUIRED | PLACE_OPTIONAL


def validate_place(p: object) -> dict:
  """Validate a place and return the normalized copy that gets stored."""
  if not isinstance(p, dict):
    raise ValidationError("place must be an object")
  extra = set(p) - PLACE_ALL
  if extra:
    raise ValidationError(f"unknown fields: {sorted(extra)}")
  missing = PLACE_REQUIRED - set(p)
  if missing:
    raise ValidationError(f"missing required fields: {sorted(missing)}")
  name = p["name"]
  if not isinstance(name, str) or not name.strip() or len(name) > 200:
    raise ValidationError("name must be a non-empty string (<=200 chars)")
  lat = p["lat"]
  if not isinstance(lat, (int, float)) or isinstance(lat, bool) or not (-90 <= lat <= 90):
    raise ValidationError("lat must be a number in [-90, 90]")
  lon = p["lon"]
  if not isinstance(lon, (int, float)) or isinstance(lon, bool) or not (-180 <= lon <= 180):
    raise ValidationError("lon must be a number in [-180, 180]")
  out = {"name": name.strip(), "lat": float(lat), "lon": float(lon)}
  for key, check in PLACE_FIELDS.items():
    value = check(key, p[key]) if key in p else PLACE_DEFAULTS.get(key, _OMIT)
    if key == "country_code":
      value = country_code_for(out.get("country")) or _OMIT
    if value is not _OMIT:
      out[key] = value
  return out


def backfill_country_codes(conn: sqlite3.Connection, uid: int) -> int:
  """Set or refresh country_code on every place of a user from its free-text
  country. Runs at startup, so places written before the field existed get
  one, and a name the table learns in a later release gets matched. Returns
  how many places changed."""
  changed = 0
  with transaction(conn):
    for row in conn.execute(
      "SELECT id, data FROM store_items WHERE user_id=? AND kind='place' AND deleted=0", (uid,)
    ).fetchall():
      p = json.loads(row["data"])
      if not isinstance(p, dict):
        continue
      code = country_code_for(p.get("country"))
      if p.get("country_code") == code:
        continue
      rest = {k: v for k, v in p.items() if k != "country_code"}
      out = {}
      for k, v in rest.items():
        out[k] = v
        if k == "country" and code is not None:
          out["country_code"] = code
      put_item(conn, uid, "place", row["id"], out)
      changed += 1
  return changed
