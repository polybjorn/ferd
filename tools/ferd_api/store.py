"""Per-user items in SQLite, one row each with a per-user revision.

Places, areas, route manifest entries, route metadata, preferences and category
labels all live in store_items, told apart by `kind`. Every write takes the
user's next revision from store_revs and stamps it on the row, so "everything
since revision N" is one indexed range scan. A delete keeps the row as a
tombstone (deleted=1, data NULL) so that scan can report it.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from .common import ValidationError, load_json_file
from .routes import ROUTE_META_CHECKS


KINDS = ("place", "area", "route", "metadata", "pref", "label")

# Route entries are derived from the GPX files by the manifest script, so a
# client cannot write them; it uploads or moves a GPX through the file endpoints.
CLIENT_KINDS = ("place", "area", "metadata", "pref", "label")

ROUTE_META_ORDER = tuple(ROUTE_META_CHECKS)


@contextmanager
def transaction(conn: sqlite3.Connection):
  """All-or-nothing write section. IMMEDIATE takes the database write lock up
  front, so concurrent writers queue instead of failing at commit. Joins the
  caller's transaction when one is open."""
  if conn.in_transaction:
    yield
    return
  conn.execute("BEGIN IMMEDIATE")
  try:
    yield
  except BaseException:
    if conn.in_transaction:
      conn.execute("ROLLBACK")
    raise
  conn.execute("COMMIT")


@contextmanager
def snapshot(conn: sqlite3.Connection):
  """One consistent read view across several SELECT queries."""
  if conn.in_transaction:
    yield
    return
  conn.execute("BEGIN")
  try:
    yield
  finally:
    conn.execute("COMMIT")


def head_rev(conn: sqlite3.Connection, uid: int) -> int:
  row = conn.execute("SELECT rev FROM store_revs WHERE user_id=?", (uid,)).fetchone()
  return row["rev"] if row else 0


NEW_EPOCH_SQL = "lower(hex(randomblob(8)))"


def get_epoch(conn: sqlite3.Connection, uid: int) -> str:
  """The user's epoch: a random token identifying this history of revisions.
  A restored backup carries the epoch it was taken with, so an operator
  rotates it after a restore (docs/api.md); clients that see a different one
  than they stored drop their copy and pull everything again."""
  row = conn.execute("SELECT epoch FROM store_revs WHERE user_id=?", (uid,)).fetchone()
  if row is None:
    conn.execute(f"INSERT OR IGNORE INTO store_revs(user_id, rev, epoch) VALUES (?, 0, {NEW_EPOCH_SQL})", (uid,))
    row = conn.execute("SELECT epoch FROM store_revs WHERE user_id=?", (uid,)).fetchone()
  return row["epoch"]


def _bump(conn: sqlite3.Connection, uid: int) -> int:
  conn.execute(
    f"INSERT INTO store_revs(user_id, rev, epoch) VALUES (?, 1, {NEW_EPOCH_SQL}) "
    "ON CONFLICT(user_id) DO UPDATE SET rev = rev + 1",
    (uid,),
  )
  return head_rev(conn, uid)


def _dump(data) -> str:
  return json.dumps(data, ensure_ascii=False)


def _next_pos(conn: sqlite3.Connection, uid: int, kind: str) -> int:
  row = conn.execute(
    "SELECT COALESCE(MAX(pos), 0) + 1 AS n FROM store_items WHERE user_id=? AND kind=?",
    (uid, kind),
  ).fetchone()
  return row["n"]


def put_item(conn: sqlite3.Connection, uid: int, kind: str, item_id: str, data, pos: int | None = None) -> tuple[int, bool]:
  """Insert or replace one item. Returns (revision, changed). Identical data on
  a live row at the same position is a no-op that keeps its revision, so
  re-saving an unchanged item does not show up in the change feed; moving it
  does, since clients mirror the order. A tombstoned id comes back to life.
  `pos` fixes the list position; without it a new row goes last."""
  text = _dump(data)
  with transaction(conn):
    row = conn.execute(
      "SELECT pos, data, rev, deleted FROM store_items WHERE user_id=? AND kind=? AND id=?",
      (uid, kind, item_id),
    ).fetchone()
    if row and not row["deleted"] and row["data"] == text and (pos is None or pos == row["pos"]):
      return row["rev"], False
    rev = _bump(conn, uid)
    now = int(time.time())
    if row:
      conn.execute(
        "UPDATE store_items SET data=?, rev=?, updated_at=?, deleted=0, pos=? "
        "WHERE user_id=? AND kind=? AND id=?",
        (text, rev, now, pos if pos is not None else row["pos"], uid, kind, item_id),
      )
    else:
      conn.execute(
        "INSERT INTO store_items(user_id, kind, id, pos, data, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (uid, kind, item_id, pos if pos is not None else _next_pos(conn, uid, kind), text, rev, now),
      )
    return rev, True


def delete_item(conn: sqlite3.Connection, uid: int, kind: str, item_id: str) -> int | None:
  """Tombstone a live item and return its new revision; None when there was
  nothing live to delete."""
  with transaction(conn):
    row = conn.execute(
      "SELECT deleted FROM store_items WHERE user_id=? AND kind=? AND id=?",
      (uid, kind, item_id),
    ).fetchone()
    if not row or row["deleted"]:
      return None
    rev = _bump(conn, uid)
    conn.execute(
      "UPDATE store_items SET data=NULL, deleted=1, rev=?, updated_at=? WHERE user_id=? AND kind=? AND id=?",
      (rev, int(time.time()), uid, kind, item_id),
    )
    return rev


def item_rev(conn: sqlite3.Connection, uid: int, kind: str, item_id: str) -> int | None:
  """Revision of the row, tombstone included; None when there never was one."""
  row = conn.execute(
    "SELECT rev FROM store_items WHERE user_id=? AND kind=? AND id=?", (uid, kind, item_id)
  ).fetchone()
  return row["rev"] if row else None


def get_item(conn: sqlite3.Connection, uid: int, kind: str, item_id: str):
  row = conn.execute(
    "SELECT data FROM store_items WHERE user_id=? AND kind=? AND id=? AND deleted=0",
    (uid, kind, item_id),
  ).fetchone()
  return json.loads(row["data"]) if row else None


def list_items(conn: sqlite3.Connection, uid: int, kind: str) -> list:
  rows = conn.execute(
    "SELECT data FROM store_items WHERE user_id=? AND kind=? AND deleted=0 ORDER BY pos",
    (uid, kind),
  ).fetchall()
  return [json.loads(r["data"]) for r in rows]


def get_map(conn: sqlite3.Connection, uid: int, kind: str) -> dict:
  """The live items of a keyed kind (metadata, pref, label) as {id: data}."""
  rows = conn.execute(
    "SELECT id, data FROM store_items WHERE user_id=? AND kind=? AND deleted=0 ORDER BY pos",
    (uid, kind),
  ).fetchall()
  return {r["id"]: json.loads(r["data"]) for r in rows}


def count_items(conn: sqlite3.Connection, uid: int, kind: str) -> int:
  return conn.execute(
    "SELECT COUNT(*) AS n FROM store_items WHERE user_id=? AND kind=? AND deleted=0",
    (uid, kind),
  ).fetchone()["n"]


def ever_had(conn: sqlite3.Connection, uid: int, kind: str) -> bool:
  """True once the kind has had any row, live or tombstoned. Export uses it to
  keep writing a file that has been emptied, as it did when the file stayed."""
  return conn.execute(
    "SELECT 1 FROM store_items WHERE user_id=? AND kind=? LIMIT 1", (uid, kind)
  ).fetchone() is not None


def items_bytes(conn: sqlite3.Connection, uid: int, kind: str) -> int:
  """Total size of the live values of a kind."""
  row = conn.execute(
    "SELECT COALESCE(SUM(LENGTH(CAST(data AS BLOB))), 0) AS n FROM store_items WHERE user_id=? AND kind=? AND deleted=0",
    (uid, kind),
  ).fetchone()
  return row["n"]


def new_id(conn: sqlite3.Connection, uid: int, kind: str) -> str:
  """An 8-char hex id unused by this user's items of the kind, tombstones
  included, so a deleted id is never handed out again."""
  while True:
    candidate = secrets.token_hex(4)
    if conn.execute(
      "SELECT 1 FROM store_items WHERE user_id=? AND kind=? AND id=?", (uid, kind, candidate)
    ).fetchone() is None:
      return candidate


def replace_list(conn: sqlite3.Connection, uid: int, kind: str, items: list) -> None:
  """Make the live set of an id-carrying kind equal `items`, in that order.
  An item without an id, or repeating one, gets a fresh id."""
  with transaction(conn):
    seen: set = set()
    keep = []
    for item in items:
      item = dict(item)
      if not isinstance(item.get("id"), str) or item["id"] in seen:
        item["id"] = new_id(conn, uid, kind)
        while item["id"] in seen:
          item["id"] = new_id(conn, uid, kind)
      seen.add(item["id"])
      keep.append(item)
    for row in conn.execute(
      "SELECT id FROM store_items WHERE user_id=? AND kind=? AND deleted=0", (uid, kind)
    ).fetchall():
      if row["id"] not in seen:
        delete_item(conn, uid, kind, row["id"])
    base = conn.execute(
      "SELECT COALESCE(MAX(pos), 0) AS n FROM store_items WHERE user_id=? AND kind=?", (uid, kind)
    ).fetchone()["n"]
    for i, item in enumerate(keep, 1):
      put_item(conn, uid, kind, item["id"], item, pos=base + i)


def append_unique_names(conn: sqlite3.Connection, uid: int, kind: str, items: list) -> int:
  """Add the items whose name no live item of the kind has. Returns how many
  were added; an id that is missing or taken gets a fresh one."""
  with transaction(conn):
    existing = list_items(conn, uid, kind)
    names = {p.get("name") for p in existing if isinstance(p, dict)}
    added = 0
    for item in items:
      if item["name"] in names:
        continue
      names.add(item["name"])
      item = dict(item)
      taken = isinstance(item.get("id"), str) and conn.execute(
        "SELECT 1 FROM store_items WHERE user_id=? AND kind=? AND id=?", (uid, kind, item["id"])
      ).fetchone() is not None
      if not isinstance(item.get("id"), str) or taken:
        item["id"] = new_id(conn, uid, kind)
      put_item(conn, uid, kind, item["id"], item)
      added += 1
    return added


def replace_map(conn: sqlite3.Connection, uid: int, kind: str, mapping: dict) -> int:
  """Make the live set of a keyed kind equal `mapping`. Returns how many keys
  were added, changed or removed."""
  with transaction(conn):
    changed = 0
    live = get_map(conn, uid, kind)
    for key in live:
      if key not in mapping:
        delete_item(conn, uid, kind, key)
        changed += 1
    for key, value in mapping.items():
      if live.get(key) != value or key not in live:
        put_item(conn, uid, kind, key, value)
        changed += 1
    return changed


def merge_map(conn: sqlite3.Connection, uid: int, kind: str, mapping: dict) -> int:
  """Overlay `mapping` onto a keyed kind. Returns how many keys changed."""
  with transaction(conn):
    live = get_map(conn, uid, kind)
    changed = 0
    for key, value in mapping.items():
      if key not in live or live[key] != value:
        put_item(conn, uid, kind, key, value)
        changed += 1
    return changed


def rekey_metadata(conn: sqlite3.Connection, uid: int, renames: dict) -> int:
  """Move metadata entries to new keys ({old: new}). A live entry already at
  the new key is overwritten. Returns how many entries moved."""
  with transaction(conn):
    live = conn.execute(
      "SELECT id, pos, data FROM store_items WHERE user_id=? AND kind='metadata' AND deleted=0", (uid,)
    ).fetchall()
    moves = [(r["id"], renames[r["id"]], r["pos"], json.loads(r["data"])) for r in live if r["id"] in renames]
    for old, _new, _pos, _data in moves:
      delete_item(conn, uid, "metadata", old)
    for _old, new, pos, data in moves:
      put_item(conn, uid, "metadata", new, data, pos=pos)
    return len(moves)


def rekey_metadata_prefix(conn: sqlite3.Connection, uid: int, old_prefix: str, new_prefix: str) -> int:
  """Rewrite the leading region of every metadata key that starts with
  `old_prefix` (which ends in "/") to `new_prefix` ("" for no region)."""
  with transaction(conn):
    keys = [k for k in get_map(conn, uid, "metadata") if k.startswith(old_prefix)]
    return rekey_metadata(conn, uid, {k: new_prefix + k[len(old_prefix):] for k in keys})


def routes_manifest(conn: sqlite3.Connection, uid: int) -> dict:
  """The routes.json shape: route entries grouped by region, with each route's
  metadata laid over its entry."""
  meta = get_map(conn, uid, "metadata")
  regions: dict[str, dict] = {}
  for data in list_items(conn, uid, "route"):
    entry = {k: v for k, v in data.items() if k != "region"}
    stored = meta.get(entry.get("key"))
    if isinstance(stored, dict):
      for field in ROUTE_META_ORDER:
        if field in stored:
          entry[field] = stored[field]
    name = data.get("region", "")
    regions.setdefault(name, {"name": name, "routes": []})["routes"].append(entry)
  out = sorted(regions.values(), key=lambda r: (r["name"] == "", r["name"]))
  for region in out:
    region["routes"].sort(key=lambda r: r.get("name", ""))
  return {"regions": out}


def manifest_rows(manifest) -> dict:
  """{route key: row data} for a routes.json manifest, in file order. Metadata
  fields are dropped, since the metadata rows own them."""
  wanted: dict[str, dict] = {}
  regions = manifest.get("regions") if isinstance(manifest, dict) else None
  for region in regions if isinstance(regions, list) else []:
    if not isinstance(region, dict):
      continue
    for entry in region.get("routes") or []:
      if isinstance(entry, dict) and isinstance(entry.get("key"), str):
        data = {"region": region.get("name", "")}
        data.update((k, v) for k, v in entry.items() if k not in ROUTE_META_ORDER)
        wanted[entry["key"]] = data
  return wanted


def sync_route_manifest(conn: sqlite3.Connection, uid: int, manifest) -> int:
  """Reconcile the route rows with a manifest as the script writes it: new and
  changed entries are put, routes it no longer lists are tombstoned. Metadata
  fields in the entries are dropped, since the metadata rows own them. Returns
  how many rows changed."""
  wanted = manifest_rows(manifest)
  with transaction(conn):
    live = get_map(conn, uid, "route")
    changed = 0
    for key in live:
      if key not in wanted:
        delete_item(conn, uid, "route", key)
        changed += 1
    for key, data in wanted.items():
      if put_item(conn, uid, "route", key, data)[1]:
        changed += 1
    return changed


def ingest_route_manifest(conn: sqlite3.Connection, uid: int, path: Path) -> int:
  """sync_route_manifest from a routes.json on disk. A missing file reads as no
  routes; an unreadable one leaves the rows alone, since the script rewrites
  the file in place and a half-written copy must not wipe them."""
  try:
    manifest = load_json_file(path, expected_type=dict, required=False, label="routes.json")
  except ValidationError as e:
    print(f"[api] routes.json not ingested: {e}", file=sys.stderr)
    return 0
  return sync_route_manifest(conn, uid, manifest)


def changes_since(conn: sqlite3.Connection, uid: int, since: int, limit: int, epoch: str | None = None) -> dict:
  """Items written after revision `since`, oldest first, tombstones included.
  `next` is the revision to ask from next: the last one returned when `more`,
  else the head. The whole set comes back with reset=True when the caller's
  epoch is missing or not the current one, or `since` is ahead of the head
  (the server went back without its epoch being rotated)."""
  current = get_epoch(conn, uid)
  with snapshot(conn):
    head = head_rev(conn, uid)
    reset = since > head or epoch != current
    if reset:
      since = 0
    rows = conn.execute(
      "SELECT kind, id, pos, rev, updated_at, deleted, data FROM store_items "
      "WHERE user_id=? AND rev>? ORDER BY rev LIMIT ?",
      (uid, since, limit + 1),
    ).fetchall()
  more = len(rows) > limit
  rows = rows[:limit]
  changes = []
  for r in rows:
    change = {"kind": r["kind"], "id": r["id"], "pos": r["pos"], "rev": r["rev"], "updated_at": r["updated_at"], "deleted": bool(r["deleted"])}
    if not r["deleted"]:
      change["data"] = json.loads(r["data"])
    changes.append(change)
  return {
    "rev": head, "epoch": current, "reset": reset, "more": more,
    "next": rows[-1]["rev"] if more else head,
    "changes": changes,
  }


def export_files(conn: sqlite3.Connection, uid: int) -> dict[str, bytes]:
  """The user's JSON files as the export zip carries them, built from rows.
  A file is left out when its kind has never held a row, as a file that was
  never created would be."""
  built: dict[str, object] = {}
  with snapshot(conn):
    if ever_had(conn, uid, "place"):
      built["places.json"] = list_items(conn, uid, "place")
    if ever_had(conn, uid, "area"):
      built["areas.json"] = list_items(conn, uid, "area")
    if ever_had(conn, uid, "route"):
      built["routes.json"] = routes_manifest(conn, uid)
    for name, kind in (("metadata.json", "metadata"), ("prefs.json", "pref"), ("category-labels.json", "label")):
      if ever_had(conn, uid, kind):
        built[name] = get_map(conn, uid, kind)
  return {n: (json.dumps(d, ensure_ascii=False, indent=2) + "\n").encode("utf-8") for n, d in built.items()}
