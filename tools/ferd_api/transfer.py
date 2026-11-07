"""Account data import: archive staging, payload parsing and the import writers."""

from __future__ import annotations

import io
import json
import os
import secrets
import shutil
import sqlite3
import sys
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from . import store
from .areas import validate_area
from .common import ImportTooLarge, ValidationError, atomic_write_bytes, resolve_under, safe_path_component, write_json_file
from .gpx import strip_gpx_pii
from .labels import clean_category_labels
from .places import validate_place
from .users import _is_export_junk


IMPORT_MAX_BYTES = 50 * 1024 * 1024  # 50 MiB cap for zip imports

IMPORT_MAX_UNCOMPRESSED = 200 * 1024 * 1024  # 200 MiB uncompressed (zip-bomb guard)

IMPORT_READ_CHUNK = 64 * 1024

IMPORT_TOP_FILES = ("places.json", "areas.json", "routes.json", "metadata.json", "prefs.json", "category-labels.json")


def read_zip_entry_bounded(zf: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int) -> bytes:
  """Read one archive entry in chunks, raising ImportTooLarge once it yields
  more than `limit` bytes and ValidationError on a corrupt entry. The bound is
  counted on the bytes the stream produces, since `info.file_size` comes from
  the uploader."""
  chunks = []
  total = 0
  try:
    with zf.open(info) as fh:
      while chunk := fh.read(IMPORT_READ_CHUNK):
        total += len(chunk)
        if total > limit:
          raise ImportTooLarge("uncompressed size exceeds limit")
        chunks.append(chunk)
  except zipfile.BadZipFile as e:
    raise ValidationError(f"failed reading {info.filename}: {e}")
  return b"".join(chunks)


@dataclass
class ImportPayload:
  """An archive's contents after validation: places normalized by
  validate_place, labels cleaned, GPX stripped of PII. None means the archive
  had no such file."""
  places: list | None = None
  areas: list | None = None
  routes: dict | None = None
  metadata: dict | None = None
  prefs: dict | None = None
  labels: dict | None = None
  gpx: dict[str, bytes] = field(default_factory=dict)


def stage_archive(raw: bytes) -> dict[str, bytes]:
  """Read the allowlisted entries of an import zip into memory, keyed by
  archive name. Raises ImportTooLarge past IMPORT_MAX_UNCOMPRESSED and
  ValidationError on anything else wrong with the archive."""
  try:
    zf = zipfile.ZipFile(io.BytesIO(raw))
  except zipfile.BadZipFile as e:
    raise ValidationError(f"invalid zip: {e}")
  staged: dict[str, bytes] = {}
  total_declared = 0
  total_read = 0
  for info in zf.infolist():
    if info.is_dir():
      continue
    name = info.filename
    if name.startswith("/") or "\\" in name or ".." in name.split("/"):
      raise ValidationError(f"invalid entry: {name}")
    # Silently skip junk added by OS archivers: macOS resource forks
    # (__MACOSX/, ._*), macOS folder metadata (.DS_Store), Windows
    # (Thumbs.db, desktop.ini), and editor backups (*.bak, *~).
    base = name.rsplit("/", 1)[-1]
    if name.startswith("__MACOSX/") or _is_export_junk(base):
      continue
    parts = name.split("/")
    if name in IMPORT_TOP_FILES:
      pass
    elif len(parts) in (2, 3) and parts[0] == "gpx" and parts[-1].endswith(".gpx"):
      # gpx/<region>/<route>.gpx, or gpx/<route>.gpx for a route with no region.
      try:
        for component in parts[1:-1] + [parts[-1][:-4]]:
          safe_path_component(component)
      except ValidationError as e:
        raise ValidationError(f"invalid gpx path '{name}': {e}")
    else:
      raise ValidationError(f"unexpected file in zip: {name}")
    # The declared size rejects an honest oversized archive before any
    # decompression; only the bounded read below holds against a lying one.
    total_declared += info.file_size
    if total_declared > IMPORT_MAX_UNCOMPRESSED:
      raise ImportTooLarge("uncompressed size exceeds limit")
    try:
      staged[name] = read_zip_entry_bounded(zf, info, IMPORT_MAX_UNCOMPRESSED - total_read)
    except ValidationError:
      raise
    except Exception as e:
      raise ValidationError(f"failed reading {name}: {e}")
    total_read += len(staged[name])
  return staged


def _parse_staged_json(staged: dict[str, bytes], arcname: str, expected_type: type):
  if arcname not in staged:
    return None
  try:
    data = json.loads(staged[arcname].decode("utf-8"))
  except (json.JSONDecodeError, UnicodeDecodeError) as e:
    raise ValidationError(f"{arcname} not valid JSON: {e}")
  if not isinstance(data, expected_type):
    kind = "an array" if expected_type is list else "an object"
    raise ValidationError(f"{arcname} must be {kind}")
  return data


def parse_payloads(staged: dict[str, bytes], mode: str) -> ImportPayload:
  """Parse and validate staged entries. Every JSON file must parse in every
  mode; places and GPX are only validated when the mode will write them."""
  out = ImportPayload(
    places=_parse_staged_json(staged, "places.json", list),
    areas=_parse_staged_json(staged, "areas.json", list),
    routes=_parse_staged_json(staged, "routes.json", dict),
    metadata=_parse_staged_json(staged, "metadata.json", dict),
    prefs=_parse_staged_json(staged, "prefs.json", dict),
    labels=_parse_staged_json(staged, "category-labels.json", dict),
  )
  if out.labels is not None:
    try:
      out.labels = clean_category_labels(out.labels)
    except ValidationError as e:
      raise ValidationError(f"category-labels.json: {e}")
  if mode == "prefs":
    return out
  if out.places is not None:
    normalized = []
    for i, p in enumerate(out.places):
      try:
        normalized.append(validate_place(p))
      except ValidationError as e:
        raise ValidationError(f"places.json[{i}]: {e}")
    out.places = normalized
  if out.areas is not None:
    normalized = []
    for i, a in enumerate(out.areas):
      try:
        normalized.append(validate_area(a))
      except ValidationError as e:
        raise ValidationError(f"areas.json[{i}]: {e}")
    out.areas = normalized
  for arcname, data in staged.items():
    if arcname.startswith("gpx/"):
      try:
        out.gpx[arcname] = strip_gpx_pii(data)
      except ValidationError as e:
        raise ValidationError(f"{arcname}: {e}")
  return out


def _write_import_gpx(udir: Path, gpx: dict[str, bytes]) -> None:
  for arcname, data in gpx.items():
    # Contain against gpx/ rather than udir, so a gpx/ that is a symlink to an
    # external directory still takes the write, as the GPX endpoints allow.
    target = resolve_under(udir / "gpx", *arcname.split("/")[1:])
    target.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(target, data)


def _remove_path(path: Path) -> None:
  if path.is_symlink() or path.is_file():
    path.unlink()
  elif path.exists():
    shutil.rmtree(path)


def import_replace(conn: sqlite3.Connection, uid: int, udir: Path, payload: ImportPayload) -> dict:
  """Make the account equal the archive: rows are replaced by its files' items
  and the GPX tree by its tracks.

  The tracks are written to a staging folder beside the user folder first, so
  the write transaction (which blocks every user's writes) holds only row work
  and two renames. A failure at any point puts the old tree back and rolls the
  rows back, leaving both as they were."""
  token = secrets.token_hex(4)
  stage = udir / f".import-{token}"
  aside = udir / f".gpx-old-{token}"
  gpx_root = udir / "gpx"
  swapped = False
  try:
    _write_import_gpx(stage, payload.gpx)
    (stage / "gpx").mkdir(parents=True, exist_ok=True)
    try:
      with store.transaction(conn):
        store.replace_list(conn, uid, "place", payload.places or [])
        store.replace_list(conn, uid, "area", payload.areas or [])
        store.replace_map(conn, uid, "metadata", payload.metadata or {})
        store.replace_map(conn, uid, "pref", payload.prefs or {})
        store.replace_map(conn, uid, "label", payload.labels or {})
        store.sync_route_manifest(conn, uid, payload.routes or {})
        # A symlinked gpx/ is renamed as a link, never followed, so replace-mode
        # cannot wipe a user-managed external directory.
        if gpx_root.is_symlink() or gpx_root.exists():
          os.rename(gpx_root, aside)
        os.rename(stage / "gpx", gpx_root)
        swapped = True
    except BaseException:
      if swapped:
        os.rename(gpx_root, stage / "gpx")
      if aside.is_symlink() or aside.exists():
        os.rename(aside, gpx_root)
      raise
    _remove_path(aside)
  finally:
    _remove_path(stage)
  routes_file = udir / "routes.json"
  try:
    if payload.routes is not None:
      write_json_file(routes_file, payload.routes)
    elif routes_file.exists():
      routes_file.unlink()
  except OSError as e:
    print(f"[api] import: routes.json not refreshed: {e}", file=sys.stderr)
  return {
    "added_places": len(payload.places or []),
    "added_areas": len(payload.areas or []),
    "changed_meta": len(payload.metadata or {}),
    "changed_prefs": len(payload.prefs or {}),
  }


def _merge_prefs_and_labels(conn: sqlite3.Connection, uid: int, payload: ImportPayload) -> int:
  changed_prefs = 0
  if payload.prefs is not None:
    changed_prefs = store.merge_map(conn, uid, "pref", payload.prefs)
  if payload.labels is not None:
    store.merge_map(conn, uid, "label", payload.labels)
  return changed_prefs


def import_merge(conn: sqlite3.Connection, uid: int, udir: Path, payload: ImportPayload) -> dict:
  with store.transaction(conn):
    added = store.append_unique_names(conn, uid, "place", payload.places or [])
    added_areas = store.append_unique_names(conn, uid, "area", payload.areas or [])
    changed_meta = 0
    if payload.metadata is not None:
      changed_meta = store.merge_map(conn, uid, "metadata", payload.metadata)
    changed_prefs = _merge_prefs_and_labels(conn, uid, payload)
  # After the commit, so file writes never hold the database lock. A failure
  # here is reported as a failed import; running the merge again is safe.
  _write_import_gpx(udir, payload.gpx)
  return {"added_places": added, "added_areas": added_areas, "changed_meta": changed_meta, "changed_prefs": changed_prefs}


def import_prefs(conn: sqlite3.Connection, uid: int, udir: Path, payload: ImportPayload) -> dict:
  """Preferences-only import: prefs and category labels, nothing else."""
  with store.transaction(conn):
    changed_prefs = _merge_prefs_and_labels(conn, uid, payload)
  return {"added_places": 0, "added_areas": 0, "changed_meta": 0, "changed_prefs": changed_prefs}


IMPORT_WRITERS = {"replace": import_replace, "merge": import_merge, "prefs": import_prefs}
