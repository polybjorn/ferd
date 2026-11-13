"""SQLite connection, schema, migrations, audit log and site settings."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path


# How long a connection waits for another one's write lock before failing with
# "database is locked". Each request opens its own connection, so every write
# queues on SQLite's lock; with sqlite3's default of 5 seconds, a burst of
# writes on a slow disk (each commit is an fsync) outlasts the wait and the
# request fails with an unhandled error.
BUSY_TIMEOUT_SECONDS = 30.0


def db_connect(path: str) -> sqlite3.Connection:
  parent = Path(path).parent
  created_dir = not parent.exists()
  parent.mkdir(parents=True, exist_ok=True)
  if created_dir:
    try:
      os.chmod(parent, 0o700)
    except OSError:
      pass
  new_db = not Path(path).exists()
  conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=BUSY_TIMEOUT_SECONDS)
  conn.execute("PRAGMA journal_mode=WAL")
  conn.execute("PRAGMA foreign_keys=ON")
  conn.row_factory = sqlite3.Row
  if new_db:
    try:
      os.chmod(path, 0o600)
    except OSError:
      pass
  # WAL/SHM siblings may be created later; chmod best-effort.
  for sibling in (path + "-wal", path + "-shm"):
    if os.path.exists(sibling):
      try:
        os.chmod(sibling, 0o600)
      except OSError:
        pass
  return conn


def db_migrate(conn: sqlite3.Connection) -> None:
  """Forward-compatible column adds and renames."""
  cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
  if "last_seen_at" not in cols:
    conn.execute("ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0")
  if "ip" not in cols:
    conn.execute("ALTER TABLE sessions ADD COLUMN ip TEXT")
  if "user_agent" not in cols:
    conn.execute("ALTER TABLE sessions ADD COLUMN user_agent TEXT")
  user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
  if "published" not in user_cols:
    conn.execute("ALTER TABLE users ADD COLUMN published INTEGER NOT NULL DEFAULT 0")
  if "is_operator" in user_cols and "is_admin" not in user_cols:
    conn.execute("ALTER TABLE users RENAME COLUMN is_operator TO is_admin")
  # Session tokens are now stored sha256-hashed (64 hex chars). Purge any
  # legacy plaintext rows (token_urlsafe(32) is 43 chars) so they fail lookup
  # cleanly instead of lingering; affected users just log in again once.
  conn.execute("DELETE FROM sessions WHERE length(token) <> 64")
  rev_cols = {r["name"] for r in conn.execute("PRAGMA table_info(store_revs)")}
  if rev_cols and "epoch" not in rev_cols:
    conn.execute("ALTER TABLE store_revs ADD COLUMN epoch TEXT NOT NULL DEFAULT ''")
  conn.execute("UPDATE store_revs SET epoch = lower(hex(randomblob(8))) WHERE epoch = ''")


def db_init(conn: sqlite3.Connection) -> None:
  conn.executescript("""
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pw_salt BLOB NOT NULL,
      pw_hash BLOB NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      ip TEXT,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'full',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      actor TEXT,
      action TEXT NOT NULL,
      target TEXT,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_id_desc ON audit_log(id DESC);
    CREATE TABLE IF NOT EXISTS store_revs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      rev INTEGER NOT NULL,
      epoch TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS store_items (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      pos INTEGER NOT NULL,
      data TEXT,
      rev INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, kind, id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_store_items_rev ON store_items(user_id, rev);
  """)


AUDIT_LOG_CAP = 5000

AUDIT_LOG_PRUNE_BATCH = 500


def log_event(conn: sqlite3.Connection, actor: str | None, action: str,
              target: str | None = None, details: dict | None = None) -> None:
  """Append an audit log row. Best-effort: never raises out to the caller,
  since logging failure must not break the underlying action."""
  try:
    details_json = json.dumps(details, ensure_ascii=False) if details else None
    conn.execute(
      "INSERT INTO audit_log(ts, actor, action, target, details) VALUES (?, ?, ?, ?, ?)",
      (int(time.time()), actor, action, target, details_json),
    )
    # Prune in batches once the id span exceeds the cap. MIN(id) + MAX(id)
    # are O(1) via the primary key, so this runs on every insert without a
    # table scan. Gaps from prior prunes only trigger pruning slightly
    # earlier, which is harmless.
    row = conn.execute("SELECT MIN(id) AS lo, MAX(id) AS hi FROM audit_log").fetchone()
    if row["lo"] is not None and row["hi"] - row["lo"] > AUDIT_LOG_CAP + AUDIT_LOG_PRUNE_BATCH:
      conn.execute(
        "DELETE FROM audit_log WHERE id < ?",
        (row["hi"] - AUDIT_LOG_CAP + 1,),
      )
  except sqlite3.Error as e:
    print(f"[api] audit log failed: {e}", file=sys.stderr)


def setting_get(conn: sqlite3.Connection, key: str, default: str = "") -> str:
  row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
  return row["value"] if row else default


def setting_set(conn: sqlite3.Connection, key: str, value: str) -> None:
  conn.execute(
    "INSERT INTO settings(key,value) VALUES(?,?) "
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    (key, value),
  )
