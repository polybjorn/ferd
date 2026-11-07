"""Accounts, per-user data directories, publish flags and the legacy-data migration."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

from .auth import hash_password
from .common import ValidationError, atomic_write_bytes, resolve_under, safe_path_component, write_json_file
from .db import setting_get, setting_set


def user_count(conn: sqlite3.Connection) -> int:
  return conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]


def registration_open(conn: sqlite3.Connection) -> bool:
  if user_count(conn) == 0:
    return True
  return setting_get(conn, "registration", "closed") == "open"


def create_user(conn: sqlite3.Connection, username: str, password: str, is_admin: bool = False) -> int:
  salt, digest = hash_password(password)
  cur = conn.execute(
    "INSERT INTO users(username, pw_salt, pw_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)",
    (username, salt, digest, 1 if is_admin else 0, int(time.time())),
  )
  return cur.lastrowid


def find_user(conn: sqlite3.Connection, username: str) -> sqlite3.Row | None:
  return conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()


def seed_initial_user(conn: sqlite3.Connection, cfg: dict) -> None:
  """Single-threaded at startup, no lock needed."""
  user = (cfg.get("initial_user") or "").strip()
  pw = cfg.get("initial_password") or ""
  if not user or not pw:
    return
  if user_count(conn) == 0:
    create_user(conn, user, pw, is_admin=True)
    print(f"[api] seeded initial admin '{user}'", file=sys.stderr)


def user_dir(cfg: dict, username: str) -> Path:
  """Per-user data folder: <data_dir>/users/<username>/. Caller must already
  have validated that `username` is one of the real DB usernames; we still run
  it through safe_path_component plus resolve_under containment as defense-in-depth."""
  base = Path(cfg["data_dir"]).resolve() / "users"
  return resolve_under(base, safe_path_component(username))


def ensure_user_dir(cfg: dict, username: str) -> Path:
  d = user_dir(cfg, username)
  d.mkdir(parents=True, exist_ok=True)
  (d / "gpx").mkdir(exist_ok=True)
  return d


def user_published(conn: sqlite3.Connection, username: str) -> bool:
  row = conn.execute("SELECT published FROM users WHERE username=?", (username,)).fetchone()
  return bool(row and row["published"])


def set_user_published(conn: sqlite3.Connection, user_id: int, value: bool) -> None:
  conn.execute("UPDATE users SET published=? WHERE id=?", (1 if value else 0, user_id))


def publishing_open(conn: sqlite3.Connection) -> bool:
  """Admin-controlled global flag: when 'closed', non-admins can't toggle their
  publish state on (existing published users stay published until an admin
  unpublishes them). Defaults to open."""
  return setting_get(conn, "publishing", "open") == "open"


def catalog_baseline_open(conn: sqlite3.Connection) -> bool:
  """Admin-controlled global flag: when 'closed', the shipped baseline catalog
  (`<static_dir>/catalog.json`, tracked in the repo) is not merged into
  /api/catalog responses. Only local additions are served. Defaults to open."""
  return setting_get(conn, "catalog_baseline", "open") == "open"


def catalog_baseline_hidden(conn: sqlite3.Connection) -> set:
  """Set of shipped catalog entry names the admin has suppressed individually.
  Distinct from the all-or-nothing `catalog_baseline_open` toggle: lets the
  admin keep most of the shipped baseline but hide specific entries."""
  raw = setting_get(conn, "catalog_baseline_hidden", "")
  if not raw:
    return set()
  try:
    parsed = json.loads(raw)
  except (json.JSONDecodeError, ValueError):
    return set()
  if not isinstance(parsed, list):
    return set()
  return {n for n in parsed if isinstance(n, str)}


def catalog_baseline_set_hidden(conn: sqlite3.Connection, hidden: set) -> None:
  setting_set(conn, "catalog_baseline_hidden", json.dumps(sorted(hidden)))


def admin_count(conn: sqlite3.Connection) -> int:
  return conn.execute("SELECT COUNT(*) AS n FROM users WHERE is_admin=1").fetchone()["n"]


def _is_export_junk(base: str) -> bool:
  """True for files that aren't user data: editor/maintenance backups (*.bak,
  timestamped *.bak-YYYYMMDD-HHMMSS copies, *~), macOS resource forks (._*) and
  folder metadata (.DS_Store), Windows junk (Thumbs.db, desktop.ini). Keeps
  export and import symmetric."""
  return (base.startswith("._")
          or base in (".DS_Store", "Thumbs.db", "desktop.ini")
          or base.endswith(".bak") or ".bak-" in base or base.endswith("~"))


def _walk_follow_symlinks(path: Path):
  """os.walk(followlinks=True) with cycle protection. Yields (root, files)
  pairs, deduping directories by (dev, ino) so a self-referential symlink
  inside `path` can't hang the walker or double-count its target."""
  if not path.exists():
    return
  seen: set[tuple[int, int]] = set()
  for root, dirs, files in os.walk(path, followlinks=True):
    try:
      st = os.stat(root)
    except OSError:
      dirs[:] = []
      continue
    key = (st.st_dev, st.st_ino)
    if key in seen:
      dirs[:] = []
      continue
    seen.add(key)
    yield root, files


def dir_size_bytes(path: Path) -> int:
  """Walk a directory tree and return total bytes of regular files. Follows
  symlinks (a dev setup may symlink user data dirs to another disk)
  with cycle protection. Best effort: any per-file stat error is skipped."""
  total = 0
  for root, files in _walk_follow_symlinks(path):
    for fname in files:
      try:
        total += (Path(root) / fname).stat().st_size
      except OSError:
        continue
  return total


def count_user_places(udir: Path) -> int:
  try:
    data = json.loads((udir / "places.json").read_text("utf-8"))
    return len(data) if isinstance(data, list) else 0
  except (OSError, json.JSONDecodeError):
    return 0


def count_user_routes(udir: Path) -> int:
  gpx_root = udir / "gpx"
  if not gpx_root.exists():
    return 0
  return sum(1 for _ in gpx_root.rglob("*.gpx") if _.is_file())


def migrate_legacy_data(conn: sqlite3.Connection, cfg: dict) -> None:
  """One-shot: move legacy shared `places.json` + `gpx/` + `metadata.json` +
  `routes.json` into the first admin's folder. For each file: skipped if
  the source doesn't exist or a non-empty destination is already there
  (so an already-migrated install or a user with their own data is left
  alone). Run before ensure_user_dir so the freshly-created empty
  per-user folder doesn't block the move."""
  data_dir = Path(cfg["data_dir"]).resolve()
  row = conn.execute(
    "SELECT username FROM users WHERE is_admin=1 ORDER BY id LIMIT 1"
  ).fetchone()
  if not row:
    return
  admin = row["username"]
  try:
    dest = user_dir(cfg, admin)
  except ValidationError:
    return
  dest.mkdir(parents=True, exist_ok=True)
  candidates = ["places.json", "routes.json", "metadata.json", "gpx"]
  moved = []
  for name in candidates:
    src = data_dir / name
    dst = dest / name
    if not src.exists() and not src.is_symlink():
      continue
    if dst.exists():
      # Treat an empty directory as absent so a freshly seeded user folder
      # doesn't block the gpx tree from being migrated.
      if dst.is_dir() and not any(dst.iterdir()):
        dst.rmdir()
      else:
        continue
    src.rename(dst)
    moved.append(name)
  if moved:
    print(f"[api] migrated legacy {moved} -> users/{admin}/", file=sys.stderr)

  # One-shot: move site-config's `category_labels` into the admin's per-user
  # file (where labels live since 2026-05-22). Skipped if the admin already has
  # a labels file or if site-config doesn't carry any.
  site_cfg_path = data_dir / "site-config.json"
  if site_cfg_path.exists():
    try:
      cfg_data = json.loads(site_cfg_path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as e:
      print(f"[api] migration: could not read site-config.json: {e}", file=sys.stderr)
      return
    legacy_labels = cfg_data.get("category_labels") if isinstance(cfg_data, dict) else None
    if isinstance(legacy_labels, dict) and legacy_labels:
      dst_labels = dest / "category-labels.json"
      if not dst_labels.exists():
        try:
          write_json_file(dst_labels, legacy_labels)
        except OSError as e:
          print(f"[api] migration: could not write {dst_labels}: {e}", file=sys.stderr)
          return
      try:
        cfg_data.pop("category_labels", None)
        atomic_write_bytes(site_cfg_path, (json.dumps(cfg_data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        print(f"[api] migrated site-config category_labels -> users/{admin}/category-labels.json", file=sys.stderr)
      except OSError as e:
        print(f"[api] migration: copied labels but could not strip from site-config: {e}", file=sys.stderr)
