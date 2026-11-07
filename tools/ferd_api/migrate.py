"""One-time copy of a user's JSON files into the store_items rows."""

from __future__ import annotations

import json
import secrets
import sqlite3
import sys
import time
from pathlib import Path

from .common import ValidationError, load_json_file
from .store import NEW_EPOCH_SQL, head_rev, manifest_rows, transaction


def _read_json(path: Path, expected_type: type):
  """Read one file; an error names the user folder and file so the log and the
  response say which one to fix."""
  label = f"{path.parent.name}/{path.name}"
  try:
    return load_json_file(path, expected_type=expected_type, required=False, label=label)
  except OSError as e:
    raise ValidationError(f"{label} could not be read: {e.strerror or e}")


def _insert_if_absent(conn: sqlite3.Connection, uid: int, kind: str, item_id: str, pos: int, data, rev: int, now: int) -> bool:
  cur = conn.execute(
    "INSERT OR IGNORE INTO store_items(user_id, kind, id, pos, data, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    (uid, kind, item_id, pos, json.dumps(data, ensure_ascii=False), rev, now),
  )
  return cur.rowcount == 1


def migrate_user(conn: sqlite3.Connection, uid: int, udir: Path):
  """Copy a user's JSON files into rows. Returns False when already done, else
  a dict of how many rows each kind got.

  A missing user folder raises, so a wrong data_dir or a restore that lost the
  folders defers instead of sealing the user as migrated with no data.

  The JSON files are only read. Rows and the store_migrated marker commit
  together, so a crash or an unreadable file leaves nothing behind and the
  next start begins again from the files. An id that is missing or repeated in
  places.json or areas.json gets a fresh one here, which is what lets the sync
  feed address every item."""
  if conn.execute("SELECT 1 FROM store_migrated WHERE user_id=?", (uid,)).fetchone():
    return False
  if not udir.is_dir():
    raise ValidationError(f"user folder {udir.name} is missing")
  places = _read_json(udir / "places.json", list)
  areas = _read_json(udir / "areas.json", list)
  metadata = _read_json(udir / "metadata.json", dict)
  prefs = _read_json(udir / "prefs.json", dict)
  labels = _read_json(udir / "category-labels.json", dict)
  manifest = _read_json(udir / "routes.json", dict)
  with transaction(conn):
    if conn.execute("SELECT 1 FROM store_migrated WHERE user_id=?", (uid,)).fetchone():
      return False
    now = int(time.time())
    rev = head_rev(conn, uid)

    counts = {"places": 0, "areas": 0, "metadata": 0, "routes": 0, "prefs": 0, "labels": 0}
    names = {"place": "places", "area": "areas", "metadata": "metadata", "route": "routes", "pref": "prefs", "label": "labels"}

    def add(kind: str, item_id: str, pos: int, data) -> None:
      nonlocal rev
      if _insert_if_absent(conn, uid, kind, item_id, pos, data, rev + 1, now):
        rev += 1
        counts[names[kind]] += 1

    for kind, items in (("place", places), ("area", areas)):
      seen: set = set()
      for item in items:
        if not isinstance(item, dict):
          print(f"[api] migration: skipped a non-object entry in the {kind}s of user {uid}", file=sys.stderr)
          continue
        item = dict(item)
        if not isinstance(item.get("id"), str) or item["id"] in seen:
          item["id"] = secrets.token_hex(4)
          while item["id"] in seen:
            item["id"] = secrets.token_hex(4)
        seen.add(item["id"])
        add(kind, item["id"], len(seen), item)
    for pos, (key, value) in enumerate(metadata.items(), 1):
      add("metadata", key, pos, value)
    for pos, (key, value) in enumerate(prefs.items(), 1):
      add("pref", key, pos, value)
    for pos, (key, value) in enumerate(labels.items(), 1):
      add("label", key, pos, value)
    for pos, (key, data) in enumerate(manifest_rows(manifest).items(), 1):
      add("route", key, pos, data)
    if rev != head_rev(conn, uid):
      conn.execute(
        f"INSERT INTO store_revs(user_id, rev, epoch) VALUES (?, ?, {NEW_EPOCH_SQL}) ON CONFLICT(user_id) DO UPDATE SET rev=excluded.rev",
        (uid, rev),
      )
    conn.execute("INSERT INTO store_migrated(user_id, migrated_at) VALUES (?, ?)", (uid, now))
  return counts


def ensure_migrated(conn: sqlite3.Connection, uid: int, udir: Path) -> None:
  """One indexed lookup per request; migrates a user the startup pass could
  not (an unreadable file then, a user created since). Raises ValidationError
  if the files are still unreadable."""
  if conn.execute("SELECT 1 FROM store_migrated WHERE user_id=?", (uid,)).fetchone():
    return
  migrate_user(conn, uid, udir)


FROZEN_FILES = ("places.json", "areas.json", "metadata.json", "prefs.json", "category-labels.json")


def edited_after_migration(conn: sqlite3.Connection, uid: int, udir: Path) -> list:
  """Names of the frozen JSON files modified after the user was migrated.
  Nothing reads them any more, so a newer one means an older version ran
  against the folder (a rollback or a second deploy) and its edits are not in
  the database. routes.json is left out because the manifest script rewrites
  it on every route change."""
  row = conn.execute("SELECT migrated_at FROM store_migrated WHERE user_id=?", (uid,)).fetchone()
  if not row:
    return []
  stale = []
  for name in FROZEN_FILES:
    try:
      if int((udir / name).stat().st_mtime) > row["migrated_at"]:
        stale.append(name)
    except OSError:
      continue
  return stale
