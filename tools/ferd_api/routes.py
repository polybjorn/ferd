"""Route metadata validation."""

from __future__ import annotations

from urllib.parse import urlparse

from .common import ValidationError, _OMIT, _check_date, _check_rating, normalize_tags


# Route metadata fields and their constraints (used by /api/metadata).
ROUTE_META_FIELDS = {"source", "date_completed", "rating", "notes", "tags", "difficulty", "local_name"}

ROUTE_DIFFICULTIES = ("easy", "moderate", "hard", "expert")


def _route_text(max_len: int):
  """Spec for an optional free-text route field: blank after strip drops it."""
  def check(key: str, v: object):
    if not isinstance(v, str):
      raise ValidationError(f"{key} must be a string")
    stripped = v.strip()
    if not stripped:
      return _OMIT
    if len(stripped) > max_len:
      raise ValidationError(f"{key} too long (max {max_len} chars)")
    return stripped
  return check


_route_notes = _route_text(2000)

_route_local_name = _route_text(200)

_route_source_text = _route_text(500)


def _route_source(key: str, v: object):
  s = _route_source_text(key, v)
  if s is _OMIT:
    return _OMIT
  try:
    parsed = urlparse(s)
  except ValueError:
    raise ValidationError("source is not a valid URL")
  if parsed.scheme not in ("http", "https") or not parsed.netloc:
    raise ValidationError("source must be an http or https URL")
  return s


def _route_date_completed(key: str, v: object):
  _check_date(v, key)
  return v


def _route_rating(key: str, v: object):
  _check_rating(v)
  return v


def _route_tags(key: str, v: object):
  # Unlike the other fields, any falsy value (not only None or "") means unset.
  return (normalize_tags(v) or _OMIT) if v else _OMIT


def _route_difficulty(key: str, v: object):
  if v not in ROUTE_DIFFICULTIES:
    raise ValidationError(f"difficulty must be one of: {', '.join(ROUTE_DIFFICULTIES)}")
  return v


# One spec per route metadata field: check(key, value) raises ValidationError
# or returns the value to store, or _OMIT to leave it out. None and "" never
# reach a check. Order is the order fields are checked and written.
ROUTE_META_CHECKS = {
  "source": _route_source,
  "date_completed": _route_date_completed,
  "rating": _route_rating,
  "notes": _route_notes,
  "tags": _route_tags,
  "difficulty": _route_difficulty,
  "local_name": _route_local_name,
}


def validate_route_metadata(m: object) -> dict:
  """Validate a per-route metadata payload. Returns a normalized dict containing
  only the fields that have a non-empty value. Raises ValidationError on any
  invalid input."""
  if not isinstance(m, dict):
    raise ValidationError("metadata must be an object")
  unknown = set(m.keys()) - ROUTE_META_FIELDS
  if unknown:
    raise ValidationError(f"unknown fields: {sorted(unknown)}")
  out: dict = {}
  for key, check in ROUTE_META_CHECKS.items():
    v = m.get(key)
    if v is None or v == "":
      continue
    value = check(key, v)
    if value is not _OMIT:
      out[key] = value
  return out
