"""Account data import: archive staging, payload parsing and the import writers."""

from __future__ import annotations

import io
import json
import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from .areas import validate_area
from .common import ImportTooLarge, ValidationError, atomic_write_bytes, load_json_file, resolve_under, safe_path_component, write_json_file
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


def _merge_json_object(path: Path, new: dict, label: str) -> int:
  """Overlay `new` onto the object stored at `path`; return how many keys changed."""
  existing = load_json_file(path, expected_type=dict, required=False, label=label)
  changed = sum(1 for k, v in new.items() if existing.get(k) != v)
  existing.update(new)
  write_json_file(path, existing)
  return changed


def _write_import_gpx(udir: Path, gpx: dict[str, bytes]) -> None:
  for arcname, data in gpx.items():
    # Contain against gpx/ rather than udir, so a gpx/ that is a symlink to an
    # external directory still takes the write, as the GPX endpoints allow.
    target = resolve_under(udir / "gpx", *arcname.split("/")[1:])
    target.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(target, data)


def import_replace(udir: Path, payload: ImportPayload) -> dict:
  for name in IMPORT_TOP_FILES:
    p = udir / name
    if p.exists():
      p.unlink()
  gpx_root = udir / "gpx"
  if gpx_root.is_symlink():
    # Replace-mode wipes the GPX tree. If it's a symlink, drop the link itself
    # rather than rmtree-ing the target (which could be a user-managed
    # external directory).
    gpx_root.unlink()
  elif gpx_root.exists():
    shutil.rmtree(gpx_root)
  files = {
    "places.json": payload.places,
    "areas.json": payload.areas,
    "routes.json": payload.routes,
    "metadata.json": payload.metadata,
    "prefs.json": payload.prefs,
    "category-labels.json": payload.labels,
  }
  for name, data in files.items():
    if data is not None:
      write_json_file(udir / name, data)
  _write_import_gpx(udir, payload.gpx)
  return {
    "added_places": len(payload.places or []),
    "added_areas": len(payload.areas or []),
    "changed_meta": len(payload.metadata or {}),
    "changed_prefs": len(payload.prefs or {}),
  }


def _merge_prefs_and_labels(udir: Path, payload: ImportPayload) -> int:
  changed_prefs = 0
  if payload.prefs is not None:
    changed_prefs = _merge_json_object(udir / "prefs.json", payload.prefs, "prefs.json")
  if payload.labels is not None:
    _merge_json_object(udir / "category-labels.json", payload.labels, "category-labels.json")
  return changed_prefs


def import_merge(udir: Path, payload: ImportPayload) -> dict:
  def merge_by_name(filename: str, incoming: list | None) -> int:
    if incoming is None:
      return 0
    path = udir / filename
    existing = load_json_file(path, expected_type=list, required=False, label=filename)
    names = {p.get("name") for p in existing if isinstance(p, dict)}
    count = 0
    for p in incoming:
      if p["name"] not in names:
        existing.append(p)
        names.add(p["name"])
        count += 1
    write_json_file(path, existing)
    return count

  added = merge_by_name("places.json", payload.places)
  added_areas = merge_by_name("areas.json", payload.areas)
  changed_meta = 0
  if payload.metadata is not None:
    changed_meta = _merge_json_object(udir / "metadata.json", payload.metadata, "metadata.json")
  changed_prefs = _merge_prefs_and_labels(udir, payload)
  _write_import_gpx(udir, payload.gpx)
  return {"added_places": added, "added_areas": added_areas, "changed_meta": changed_meta, "changed_prefs": changed_prefs}


def import_prefs(udir: Path, payload: ImportPayload) -> dict:
  """Preferences-only import: prefs.json and category-labels.json, nothing else."""
  return {"added_places": 0, "added_areas": 0, "changed_meta": 0, "changed_prefs": _merge_prefs_and_labels(udir, payload)}


IMPORT_WRITERS = {"replace": import_replace, "merge": import_merge, "prefs": import_prefs}
