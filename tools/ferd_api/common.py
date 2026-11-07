"""Shared exceptions, path-safety helpers and atomic JSON/file writes."""

from __future__ import annotations

import fcntl
import json
import os
import re
import tempfile
import unicodedata
from pathlib import Path


# Allow any non-control, non-separator character. The real security boundary
# is resolve_under() (the resolved path must stay inside the base). The dot/
# dot-dot whole-string rejection lives in safe_path_component itself.
PATH_COMPONENT_RE = re.compile(r"^[^\x00-\x1f/\\]{1,255}$")

ROUTE_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

TAG_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{0,31}$")


def normalize_tags(tags: object) -> list:
  """Validate and normalize a free-form tag list (places and routes share this).

  Trims, drops blanks, dedupes case-insensitively (keeping the first-seen
  casing, so "UNESCO" survives as written), and enforces TAG_RE + a 10-tag cap.
  Raises ValidationError on a non-list, a non-string item, or a bad format.
  """
  if not isinstance(tags, list):
    raise ValidationError("tags must be a list of strings")
  cleaned: list = []
  seen: set = set()  # lowercased keys, for case-insensitive dedup
  for t in tags:
    if not isinstance(t, str):
      raise ValidationError("each tag must be a string")
    tn = t.strip()
    if not tn:
      continue
    if not TAG_RE.match(tn):
      raise ValidationError(f"invalid tag: {tn!r} (alphanumerics + hyphen, 1-32 chars, starts with alphanumeric)")
    key = tn.lower()
    if key not in seen:
      seen.add(key)
      cleaned.append(tn)
  if len(cleaned) > 10:
    raise ValidationError("too many tags (max 10)")
  return cleaned


class BodyTooLarge(Exception):
  def __init__(self, length: int, cap: int):
    super().__init__(f"body too large: {length} > {cap}")
    self.length = length
    self.cap = cap


class ValidationError(Exception):
  pass


class ImportTooLarge(ValidationError):
  pass


class NotFoundError(ValidationError):
  """Subclass for the 'this resource doesn't exist' case so callers can map
  to 404 by type rather than by string-matching the message."""
  pass


def safe_path_component(value: str) -> str:
  """Reject anything that could escape a base directory or hide tricks."""
  if not isinstance(value, str):
    raise ValidationError("must be a string")
  s = value.strip()
  if not s:
    raise ValidationError("must not be empty")
  if "\x00" in s or "/" in s or "\\" in s or s in (".", ".."):
    raise ValidationError("invalid characters")
  if not PATH_COMPONENT_RE.match(s):
    raise ValidationError("contains disallowed characters")
  return s


def nfc_component(value: str) -> str:
  """safe_path_component, composed to NFC. Every name a client writes goes
  through this, so a route or region named on a device that sends decomposed
  (NFD) text lands under the same key as one typed in the app."""
  return unicodedata.normalize("NFC", safe_path_component(value))


def nfc_route_key(key: str) -> str:
  return unicodedata.normalize("NFC", key)


def resolve_under(base: Path, *parts: str) -> Path:
  """Join base with sanitized components, then assert the result stays inside.
  Uses Path.resolve() + is_relative_to to make the containment check explicit
  for static analyzers (CodeQL py/path-injection)."""
  base_resolved = base.resolve()
  candidate = base_resolved.joinpath(*parts).resolve()
  if candidate != base_resolved and not candidate.is_relative_to(base_resolved):
    raise ValidationError("path escapes base directory")
  return candidate


def write_json_file(path: Path, data) -> None:
  """Serialize `data` as pretty JSON with trailing newline and write atomically."""
  atomic_write_bytes(path, (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def find_place_idx(places: list, place_id: str, kind: str = "place") -> int:
  """Index of the entry with this id; NotFoundError if absent."""
  for i, p in enumerate(places):
    if isinstance(p, dict) and p.get("id") == place_id:
      return i
  raise NotFoundError(f"{kind} not found: {place_id}")


def load_json_file(path: Path, *, expected_type: type, required: bool, label: str):
  """Read+parse a JSON file. Raise ValidationError on missing/invalid/wrong-type."""
  if not path.exists():
    if required:
      raise ValidationError(f"{label} not found")
    return expected_type()
  try:
    loaded = json.loads(path.read_text(encoding="utf-8"))
  except json.JSONDecodeError as e:
    raise ValidationError(f"existing {label} is not valid JSON: {e}")
  except UnicodeDecodeError as e:
    raise ValidationError(f"existing {label} is not valid UTF-8: {e}")
  if not isinstance(loaded, expected_type):
    kind = "a JSON array" if expected_type is list else "a JSON object"
    raise ValidationError(f"{label} must be {kind}")
  return loaded


def atomic_write_bytes(path: Path, data: bytes) -> None:
  """Atomic write that preserves symlinks.

  If `path` is a symlink, we resolve to the link's real target so the write
  lands on the actual file and the link itself stays intact (otherwise
  `os.replace` would replace the symlink with a regular file).
  """
  if path.is_symlink():
    target = Path(os.path.realpath(str(path)))
  else:
    target = path
  parent = target.parent
  parent.mkdir(parents=True, exist_ok=True)
  fd, tmp_path = tempfile.mkstemp(prefix=".tmp-", dir=parent)
  try:
    with os.fdopen(fd, "wb") as f:
      f.write(data)
      f.flush()
      os.fsync(f.fileno())
    os.replace(tmp_path, target)
  except Exception:
    try:
      os.unlink(tmp_path)
    except OSError:
      pass
    raise
  # fsync the directory so the rename is durable.
  dir_fd = os.open(parent, os.O_RDONLY)
  try:
    os.fsync(dir_fd)
  finally:
    os.close(dir_fd)


class ConflictError(ValidationError):
  """The target of a move already exists, so callers can map to 409 by type."""
  pass


def with_file_lock(lock_path: Path, fn):
  """Run fn() while holding an exclusive flock on lock_path. Creates the file if needed."""
  lock_path.parent.mkdir(parents=True, exist_ok=True)
  with open(lock_path, "a+") as lf:
    fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
    try:
      return fn()
    finally:
      fcntl.flock(lf.fileno(), fcntl.LOCK_UN)


_OMIT = object()


def _check_rating(r: object) -> None:
  if isinstance(r, bool) or not isinstance(r, int) or not 1 <= r <= 5:
    raise ValidationError("rating must be an integer 1-5")


def _check_date(v: object, name: str) -> None:
  if not isinstance(v, str) or not ROUTE_DATE_RE.match(v):
    raise ValidationError(f"{name} must be YYYY-MM-DD")
