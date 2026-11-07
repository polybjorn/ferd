"""One-time merge of routes stored under a decomposed (NFD) name.

Before names were normalised on the way in, a route uploaded from a device
that sends NFD text and the same route typed in the app ended up as two
routes, each with its own metadata. This pass moves every such route to its
composed (NFC) name. It is safe to run on every start: once every name is
composed there is nothing left for it to do.
"""

from __future__ import annotations

import sqlite3
import sys
import unicodedata
from pathlib import Path

from . import store
from .common import ValidationError, normalize_tags, with_file_lock

SUFFIXES = (".planned.gpx", ".gpx")


def _nfc(s: str) -> str:
  return unicodedata.normalize("NFC", s)


def _route_files(gpx_root: Path) -> dict:
  """{(region, stem): {suffix: path}} for every GPX under gpx/ and one level
  of region folders, names as stored on disk."""
  routes: dict = {}

  def add(region: str, path: Path) -> None:
    for suffix in SUFFIXES:
      if path.name.endswith(suffix):
        stem = path.name[: -len(suffix)]
        routes.setdefault((region, stem), {})[suffix] = path
        return

  if not gpx_root.is_dir():
    return routes
  for entry in sorted(gpx_root.iterdir()):
    if entry.is_file():
      add("", entry)
    elif entry.is_dir():
      for sub in sorted(entry.iterdir()):
        if sub.is_file():
          add(entry.name, sub)
  return routes


def _key(region: str, stem: str) -> str:
  return f"{region}/{stem}" if region else stem


def merge_metadata(entries: list) -> tuple[dict, list]:
  """Union of route metadata dicts. Returns (merged, conflicting field names).
  Tags merge as a set; any other field set to two different values is a
  conflict, and the merged dict is then not to be used."""
  merged: dict = {}
  conflicts: list = []
  for entry in entries:
    for field, value in entry.items():
      if field not in merged:
        merged[field] = value
      elif merged[field] == value:
        continue
      elif field == "tags" and isinstance(value, list) and isinstance(merged[field], list):
        try:
          merged[field] = normalize_tags(merged[field] + value)
        except ValidationError:
          conflicts.append(field)
      elif field not in conflicts:
        conflicts.append(field)
  return merged, conflicts


def _plan(conn: sqlite3.Connection, uid: int, gpx_root: Path) -> list:
  """The groups to merge, as (nfc region, nfc stem, members, merged metadata).
  A group whose copies differ, in GPX bytes or in a metadata field, is logged
  and left out."""
  groups: dict = {}
  for (region, stem), files in _route_files(gpx_root).items():
    groups.setdefault((_nfc(region), _nfc(stem)), []).append((region, stem, files))
  meta = store.get_map(conn, uid, "metadata")
  plans = []
  for (region, stem), members in sorted(groups.items()):
    if all(r == region and s == stem for r, s, _f in members):
      continue
    key = _key(region, stem)
    differs = []
    for suffix in SUFFIXES:
      contents = {f[suffix].read_bytes() for _r, _s, f in members if suffix in f}
      if len(contents) > 1:
        differs.append(suffix)
    if differs:
      print(f"[api] NFC merge: user {uid} route {key!r} left alone, its copies' "
            f"{' and '.join(differs)} files differ", file=sys.stderr)
      continue
    # The composed copy first, so its metadata row keeps its list position.
    member_keys = sorted({_key(r, s) for r, s, _f in members}, key=lambda k: k != key)
    if key not in member_keys:
      member_keys.insert(0, key)
    entries = [meta[k] for k in member_keys if isinstance(meta.get(k), dict)]
    merged, conflicts = merge_metadata(entries)
    if conflicts:
      print(f"[api] NFC merge: user {uid} route {key!r} left alone, its copies "
            f"disagree on {', '.join(conflicts)}", file=sys.stderr)
      continue
    plans.append((region, stem, members, member_keys, merged))
  return plans


def _apply(conn: sqlite3.Connection, uid: int, gpx_root: Path, plan) -> None:
  region, stem, members, member_keys, merged = plan
  key = member_keys[0]
  # Metadata first: if the file moves below are interrupted, the next run
  # finds the same files, still equal, and nothing more to merge.
  with store.transaction(conn):
    for k in member_keys[1:]:
      store.delete_item(conn, uid, "metadata", k)
    if merged:
      store.put_item(conn, uid, "metadata", key, merged)
  target_dir = gpx_root / region if region else gpx_root
  target_dir.mkdir(parents=True, exist_ok=True)
  emptied = set()
  for suffix in SUFFIXES:
    target = target_dir / (stem + suffix)
    for _r, _s, files in members:
      src = files.get(suffix)
      if src is None or src == target:
        continue
      if target.exists():
        src.unlink()
      else:
        src.rename(target)
      if src.parent != gpx_root:
        emptied.add(src.parent)
  for d in emptied:
    try:
      if d != target_dir and not any(d.iterdir()):
        d.rmdir()
    except OSError:
      pass


def merge_nfd_routes(conn: sqlite3.Connection, uid: int, udir: Path) -> list:
  """Move every route stored under a non-NFC name to its NFC name, merging it
  into a composed copy when there is one. Copies merge only when their GPX
  bytes are equal and no metadata field holds two values; others are logged
  and left as they are. Returns the merged keys. The caller regenerates the
  manifest when the list is not empty."""
  gpx_root = udir / "gpx"
  if not gpx_root.is_dir():
    return []

  def run():
    plans = _plan(conn, uid, gpx_root)
    for plan in plans:
      _apply(conn, uid, gpx_root, plan)
    return [plan[3][0] for plan in plans]

  merged = with_file_lock(udir / ".gpx.lock", run)
  for key in merged:
    print(f"[api] NFC merge: user {uid} route {key!r} now under its composed name", file=sys.stderr)
  return merged
