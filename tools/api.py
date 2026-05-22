#!/usr/bin/env python3
"""Atlas API server.

Stdlib-only. Provides auth (register/login/logout/change-password/state) and
per-user data endpoints (places, GPX trails, prefs, publish toggle, export)
backed by SQLite for accounts and a per-user folder for content.

Run: python3 tools/api.py [--config tools/config.json]
"""

from __future__ import annotations

import argparse
import fcntl
import http.cookies
import http.server
import io
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from hashlib import pbkdf2_hmac
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

SESSION_DAYS = 30
PBKDF2_ITERATIONS = 600_000
PBKDF2_DKLEN = 32
SALT_BYTES = 16
SESSION_BYTES = 32
PASSWORD_MIN = 12
PASSWORD_MAX = 256
USERNAME_MAX = 64

# Rate limit on /api/login: max failed attempts per IP within window.
RATE_LIMIT_WINDOW = 15 * 60
RATE_LIMIT_MAX_FAILS = 10

# Phase 2 (writes)
GPX_MAX_BYTES = 10 * 1024 * 1024  # 10 MiB cap for GPX uploads
IMPORT_MAX_BYTES = 50 * 1024 * 1024  # 50 MiB cap for zip imports
IMPORT_MAX_UNCOMPRESSED = 200 * 1024 * 1024  # 200 MiB uncompressed (zip-bomb guard)
IMPORT_TOP_FILES = ("places.json", "routes.json", "metadata.json", "prefs.json", "category-labels.json")
GPX_NS = "http://www.topografix.com/GPX/1/1"
# Allow any non-control, non-separator character. The real security boundary
# is resolve_under() (the resolved path must stay inside the base). The dot/
# dot-dot whole-string rejection lives in safe_path_component itself.
PATH_COMPONENT_RE = re.compile(r"^[^\x00-\x1f/\\]{1,255}$")
PLACE_REQUIRED = {"name", "lat", "lon"}
PLACE_OPTIONAL = {"category", "country", "visited", "note", "sources", "local_name", "date_visited", "rating"}
PLACE_ALL = PLACE_REQUIRED | PLACE_OPTIONAL

# Trail metadata fields and their constraints (used by /api/metadata).
TRAIL_META_FIELDS = {"source", "date_hiked", "rating", "notes", "tags", "difficulty", "local_name"}
TRAIL_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TRAIL_TAG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
TRAIL_DIFFICULTIES = ("easy", "moderate", "hard", "expert")

# Precomputed dummy hash used to equalize timing when a username doesn't exist.
_DUMMY_SALT = b"\x00" * SALT_BYTES
_DUMMY_HASH = pbkdf2_hmac("sha256", b"unused", _DUMMY_SALT, PBKDF2_ITERATIONS, dklen=PBKDF2_DKLEN)


# ---------- config ----------

DEFAULT_CONFIG = {
  "bind": "127.0.0.1:8091",
  "db_path": "tools/atlas.db",
  "data_dir": ".",
  "manifest_cmd": None,
  "initial_user": None,
  "initial_password": None,
  "secure_cookies": True,
  "max_body_bytes": 1_048_576,  # 1 MiB for JSON endpoints
  # If set, the server also serves static files from this directory for any
  # non-/api/* GET. Intended for development; in production let nginx serve
  # static and proxy /api/* to the API.
  "static_dir": None,
  # If > 0, the process exits after this many seconds with no request activity.
  # Pair with systemd socket activation for zero-idle RAM cost.
  "idle_exit_seconds": 0,
  # If true, first-run registration also requires a setup token (auto-generated
  # at startup and printed to stderr). Closes the "open registration during the
  # window between deploy and first registration" risk for public deploys.
  "require_setup_token": False,
}

STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".gpx": "application/gpx+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
}


def load_config(path: Path) -> dict:
  cfg = dict(DEFAULT_CONFIG)
  if path.exists():
    cfg.update(json.loads(path.read_text()))
  for key in cfg:
    env_key = "ATLAS_" + key.upper()
    if env_key in os.environ:
      raw = os.environ[env_key]
      if isinstance(cfg[key], bool):
        cfg[key] = raw.lower() in ("1", "true", "yes", "on")
      elif isinstance(cfg[key], int) and not isinstance(cfg[key], bool):
        cfg[key] = int(raw)
      else:
        cfg[key] = raw
  return cfg


# ---------- db ----------

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
  conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
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
  """)


def user_count(conn: sqlite3.Connection) -> int:
  return conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]


def setting_get(conn: sqlite3.Connection, key: str, default: str = "") -> str:
  row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
  return row["value"] if row else default


def setting_set(conn: sqlite3.Connection, key: str, value: str) -> None:
  conn.execute(
    "INSERT INTO settings(key,value) VALUES(?,?) "
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    (key, value),
  )


def registration_open(conn: sqlite3.Connection) -> bool:
  if user_count(conn) == 0:
    return True
  return setting_get(conn, "registration", "closed") == "open"


# ---------- passwords ----------

def hash_password(password: str) -> tuple[bytes, bytes]:
  salt = secrets.token_bytes(SALT_BYTES)
  digest = pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS, dklen=PBKDF2_DKLEN)
  return salt, digest


def verify_password(password: str, salt: bytes, expected: bytes) -> bool:
  digest = pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS, dklen=PBKDF2_DKLEN)
  return secrets.compare_digest(digest, expected)


def dummy_verify(password: str) -> bool:
  """Constant-cost stand-in for verify_password when the user doesn't exist.

  Same CPU cost as a real PBKDF2 round so login timing doesn't leak username
  existence.
  """
  digest = pbkdf2_hmac("sha256", password.encode("utf-8"), _DUMMY_SALT, PBKDF2_ITERATIONS, dklen=PBKDF2_DKLEN)
  return secrets.compare_digest(digest, _DUMMY_HASH)


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
    print(f"[atlas-api] seeded initial admin '{user}'", file=sys.stderr)


def user_dir(cfg: dict, username: str) -> Path:
  """Per-user data folder: <data_dir>/users/<username>/. Caller must already
  have validated that `username` is one of the real DB usernames; we still run
  it through safe_path_component as defense-in-depth."""
  base = Path(cfg["data_dir"]).resolve() / "users"
  return base / safe_path_component(username)


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


def admin_count(conn: sqlite3.Connection) -> int:
  return conn.execute("SELECT COUNT(*) AS n FROM users WHERE is_admin=1").fetchone()["n"]


def dir_size_bytes(path: Path) -> int:
  """Walk a directory tree and return total bytes of regular files. Follows
  symlinks (the documented dev pattern symlinks user data dirs into a Vault).
  Best effort: any per-file stat error is skipped."""
  total = 0
  if not path.exists():
    return 0
  for root, dirs, files in os.walk(path, followlinks=True):
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


def count_user_trails(udir: Path) -> int:
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
    print(f"[atlas-api] migrated legacy {moved} -> users/{admin}/", file=sys.stderr)

  # One-shot: move site-config's `category_labels` into the admin's per-user
  # file (where labels live since 2026-05-22). Skipped if the admin already has
  # a labels file or if site-config doesn't carry any.
  site_cfg_path = data_dir / "site-config.json"
  if site_cfg_path.exists():
    try:
      cfg_data = json.loads(site_cfg_path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
      return
    legacy_labels = cfg_data.get("category_labels") if isinstance(cfg_data, dict) else None
    if isinstance(legacy_labels, dict) and legacy_labels:
      dst_labels = dest / "category-labels.json"
      if not dst_labels.exists():
        try:
          write_json_file(dst_labels, legacy_labels)
        except OSError:
          return
      try:
        cfg_data.pop("category_labels", None)
        atomic_write_bytes(site_cfg_path, (json.dumps(cfg_data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        print(f"[atlas-api] migrated site-config category_labels -> users/{admin}/category-labels.json", file=sys.stderr)
      except OSError:
        pass


# ---------- sessions ----------

def session_create(conn: sqlite3.Connection, user_id: int, ip: str | None = None, user_agent: str | None = None) -> str:
  token = secrets.token_urlsafe(SESSION_BYTES)
  now = int(time.time())
  conn.execute(
    "INSERT INTO sessions(token, user_id, created_at, expires_at, last_seen_at, ip, user_agent) "
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
    (token, user_id, now, now + SESSION_DAYS * 86400, now, ip, (user_agent or "")[:300]),
  )
  return token


def session_lookup(conn: sqlite3.Connection, token: str) -> sqlite3.Row | None:
  if not token:
    return None
  row = conn.execute(
    "SELECT u.id AS id, u.username AS username, u.is_admin AS is_admin, "
    "s.expires_at AS expires_at "
    "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=?",
    (token,),
  ).fetchone()
  if row and row["expires_at"] > int(time.time()):
    return row
  if row:
    conn.execute("DELETE FROM sessions WHERE token=?", (token,))
  return None


def session_touch(conn: sqlite3.Connection, token: str) -> None:
  conn.execute("UPDATE sessions SET last_seen_at=? WHERE token=?", (int(time.time()), token))


def session_delete(conn: sqlite3.Connection, token: str) -> None:
  conn.execute("DELETE FROM sessions WHERE token=?", (token,))


# ---------- rate limit ----------

class RateLimiter:
  """Simple per-IP failure counter with a sliding window."""

  def __init__(self, max_fails: int, window: int):
    self.max_fails = max_fails
    self.window = window
    self._lock = threading.Lock()
    self._store: dict[str, list[float]] = {}

  def _prune(self, ip: str, now: float) -> list[float]:
    cutoff = now - self.window
    pruned = [t for t in self._store.get(ip, []) if t > cutoff]
    if pruned:
      self._store[ip] = pruned
    elif ip in self._store:
      del self._store[ip]
    return pruned

  def is_blocked(self, ip: str) -> bool:
    now = time.monotonic()
    with self._lock:
      return len(self._prune(ip, now)) >= self.max_fails

  def record_failure(self, ip: str) -> None:
    now = time.monotonic()
    with self._lock:
      self._prune(ip, now)
      self._store.setdefault(ip, []).append(now)

  def clear(self, ip: str) -> None:
    with self._lock:
      self._store.pop(ip, None)


# ---------- http helpers ----------

class Handler(http.server.BaseHTTPRequestHandler):
  cfg: dict = None
  login_limiter: RateLimiter = None
  # Serializes register-and-create_user (and similar read-then-write critical
  # sections) across worker threads. Each request opens its own SQLite
  # connection, so this lock is for application-level invariants, not
  # connection safety.
  write_lock: threading.Lock = None
  # Monotonic timestamp of the most recent request; consumed by the idle watcher.
  last_request: float = 0.0
  # Set on startup if `require_setup_token` is enabled and no users exist.
  # Cleared once the first user registers.
  setup_token: str | None = None

  def handle_one_request(self):
    Handler.last_request = time.monotonic()
    self._req_conn = None
    try:
      return super().handle_one_request()
    finally:
      if self._req_conn is not None:
        try:
          self._req_conn.close()
        except Exception:
          pass
        self._req_conn = None

  @property
  def conn(self) -> sqlite3.Connection:
    """Per-request SQLite connection. Python 3.9's stdlib sqlite3 module
    ships with threadsafety=1 on macOS, so a shared connection across the
    ThreadingHTTPServer workers can corrupt internal state during concurrent
    parses. Open one per request, close it in handle_one_request()."""
    if self._req_conn is None:
      c = sqlite3.connect(self.cfg["db_path"], isolation_level=None)
      c.execute("PRAGMA foreign_keys=ON")
      c.row_factory = sqlite3.Row
      self._req_conn = c
    return self._req_conn

  def log_message(self, fmt, *args):
    sys.stderr.write(f"[atlas-api] {self.address_string()} {fmt % args}\n")

  def _read_body(self) -> dict:
    cap = self.cfg.get("max_body_bytes", 1_048_576)
    length = int(self.headers.get("Content-Length") or 0)
    if length < 0:
      raise ValueError("invalid content-length")
    if length > cap:
      raise BodyTooLarge(length, cap)
    if length == 0:
      return {}
    raw = self.rfile.read(length)
    ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip()
    if ctype != "application/json":
      raise ValueError("expected application/json")
    return json.loads(raw.decode("utf-8"))

  def _read_raw(self, cap: int) -> bytes:
    length = int(self.headers.get("Content-Length") or 0)
    if length < 0:
      raise ValueError("invalid content-length")
    if length > cap:
      raise BodyTooLarge(length, cap)
    if length == 0:
      return b""
    return self.rfile.read(length)

  def _cookie_token(self) -> str:
    raw = self.headers.get("Cookie") or ""
    if not raw:
      return ""
    jar = http.cookies.SimpleCookie()
    jar.load(raw)
    morsel = jar.get("atlas_session")
    return morsel.value if morsel else ""

  def _current_user(self) -> sqlite3.Row | None:
    token = self._cookie_token()
    user = session_lookup(self.conn, token)
    if user:
      # last_seen_at is best-effort; failures are non-fatal.
      try:
        session_touch(self.conn, token)
      except sqlite3.Error:
        pass
    return user

  def _require_admin(self) -> sqlite3.Row | None:
    """Return current user if admin, else send 401/403 and return None."""
    user = self._current_user()
    if not user:
      self._error(HTTPStatus.UNAUTHORIZED, "not authenticated")
      return None
    if not user["is_admin"]:
      self._error(HTTPStatus.FORBIDDEN, "admin only")
      return None
    return user

  def _require_user(self) -> sqlite3.Row | None:
    """Return any authenticated user, else send 401 and return None."""
    user = self._current_user()
    if not user:
      self._error(HTTPStatus.UNAUTHORIZED, "not authenticated")
      return None
    return user

  def _user_dir(self, username: str) -> Path:
    """Get + ensure the per-user data dir."""
    return ensure_user_dir(self.cfg, username)

  def _client_ip(self) -> str:
    return self.client_address[0] if self.client_address else "?"

  def _send_json(self, status: int, payload: dict, extra_headers: list[tuple[str, str]] | None = None) -> None:
    body = json.dumps(payload).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(body)))
    self.send_header("Cache-Control", "no-store")
    for k, v in (extra_headers or []):
      self.send_header(k, v)
    self.end_headers()
    self.wfile.write(body)

  def _error(self, status: int, message: str) -> None:
    self._send_json(status, {"error": message})

  def _read_body_or_400(self) -> dict | None:
    try:
      return self._read_body()
    except BodyTooLarge as e:
      self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f"body too large ({e.length} > {e.cap})")
      return None
    except (ValueError, json.JSONDecodeError):
      self._error(HTTPStatus.BAD_REQUEST, "invalid body")
      return None

  def _set_session_cookie(self, token: str, max_age: int | None = None) -> tuple[str, str]:
    parts = [f"atlas_session={token}", "Path=/", "HttpOnly", "SameSite=Lax"]
    if self.cfg.get("secure_cookies", True):
      parts.append("Secure")
    if max_age is not None:
      parts.append(f"Max-Age={max_age}")
    return ("Set-Cookie", "; ".join(parts))

  # ---- routing ----

  def do_GET(self):
    path = urlparse(self.path).path
    if path == "/api/state":
      return self._h_state()
    if path == "/api/sessions":
      return self._h_sessions_list()
    if path == "/api/places":
      return self._h_places_get()
    if path == "/api/routes":
      return self._h_routes_get()
    if path == "/api/metadata":
      return self._h_metadata_get()
    if path == "/api/me/prefs":
      return self._h_prefs_get()
    if path == "/api/me/category-labels":
      return self._h_me_category_labels_get()
    if path == "/api/me/export":
      return self._h_export_get()
    if path == "/api/admin/users":
      return self._h_admin_users_list()
    if path == "/api/admin/stats":
      return self._h_admin_stats()
    if path.startswith("/api/gpx/"):
      parts = path[len("/api/gpx/"):].split("/", 1)
      if len(parts) == 2:
        return self._h_gpx_get(unquote(parts[0]), unquote(parts[1]))
      if len(parts) == 1 and parts[0]:
        return self._h_gpx_get("", unquote(parts[0]))
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    if path.startswith("/api/u/"):
      rest = path[len("/api/u/"):]
      seg = rest.split("/", 1)
      if len(seg) < 2:
        return self._error(HTTPStatus.NOT_FOUND, "not found")
      uname, tail = unquote(seg[0]), seg[1]
      if tail == "places":
        return self._h_public_places(uname)
      if tail == "routes":
        return self._h_public_routes(uname)
      if tail == "metadata":
        return self._h_public_metadata(uname)
      if tail == "category-labels":
        return self._h_public_category_labels(uname)
      if tail.startswith("gpx/"):
        gparts = tail[len("gpx/"):].split("/", 1)
        if len(gparts) == 2:
          return self._h_public_gpx(uname, unquote(gparts[0]), unquote(gparts[1]))
        if len(gparts) == 1 and gparts[0]:
          return self._h_public_gpx(uname, "", unquote(gparts[0]))
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    if path.startswith("/api/"):
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    return self._serve_static(path)

  def _serve_static(self, path: str):
    static_dir = self.cfg.get("static_dir")
    if not static_dir:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    base = Path(static_dir)
    if path in ("", "/"):
      path = "/index.html"
    # Public per-user URLs (`/u/<username>/...`) all serve the SPA shell; the
    # frontend reads the path and fetches the right /api/u/<username>/... data.
    if path.startswith("/u/"):
      path = "/index.html"
    # URL-decode percent-escapes (e.g. spaces, accented chars).
    rel = unquote(path.lstrip("/"))
    # Lexical traversal check: refuse any ".." segment or NUL byte. We don't
    # resolve symlinks for the check, so configured symlinks (gpx/, etc.) work.
    if "\x00" in rel:
      return self._send_plain(HTTPStatus.BAD_REQUEST, b"bad path")
    parts = rel.split("/")
    if any(p == ".." or p == "" for p in parts[:-1]) or ".." in parts:
      return self._send_plain(HTTPStatus.FORBIDDEN, b"forbidden")
    # Deny server-side asset directories regardless of OS path resolution.
    # tools/ holds the API code + DB + server config; deploy/ holds unit files.
    # Neither should be reachable through the static handler.
    if parts[0] in ("tools", "deploy", ".git"):
      return self._send_plain(HTTPStatus.FORBIDDEN, b"forbidden")
    target = base / rel
    if not target.exists() or not target.is_file():
      return self._send_plain(HTTPStatus.NOT_FOUND, b"not found")
    suffix = target.suffix.lower()
    ctype = STATIC_MIME.get(suffix, "application/octet-stream")
    try:
      data = target.read_bytes()
    except OSError:
      return self._send_plain(HTTPStatus.INTERNAL_SERVER_ERROR, b"read failed")
    self.send_response(HTTPStatus.OK)
    self.send_header("Content-Type", ctype)
    self.send_header("Content-Length", str(len(data)))
    self.send_header("Cache-Control", "no-cache")
    self.end_headers()
    self.wfile.write(data)

  def _send_plain(self, status: int, body: bytes):
    self.send_response(status)
    self.send_header("Content-Type", "text/plain; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def do_POST(self):
    path = urlparse(self.path).path
    if path == "/api/register":
      return self._h_register()
    if path == "/api/login":
      return self._h_login()
    if path == "/api/logout":
      return self._h_logout()
    if path == "/api/change-password":
      return self._h_change_password()
    if path == "/api/settings/registration":
      return self._h_settings_registration()
    if path == "/api/places":
      return self._h_places_create()
    if path == "/api/places/clear-category":
      return self._h_places_clear_category()
    if path == "/api/gpx":
      return self._h_gpx_upload()
    if path == "/api/regions/rename":
      return self._h_region_rename()
    if path == "/api/regions/delete":
      return self._h_region_delete()
    if path == "/api/regions/clear":
      return self._h_region_clear()
    if path == "/api/me/publish":
      return self._h_publish_post()
    if path == "/api/me/import":
      return self._h_import_post()
    if path == "/api/sessions/revoke":
      return self._h_sessions_revoke()
    if path == "/api/sessions/revoke-others":
      return self._h_sessions_revoke_others()
    if path == "/api/admin/settings/publishing":
      return self._h_admin_settings_publishing()
    if path == "/api/admin/unpublish-all":
      return self._h_admin_unpublish_all()
    if path.startswith("/api/admin/users/"):
      rest = path[len("/api/admin/users/"):]
      parts = rest.split("/", 1)
      if len(parts) == 2 and parts[0].isdigit():
        uid = int(parts[0])
        if parts[1] == "role":
          return self._h_admin_user_role(uid)
        if parts[1] == "unpublish":
          return self._h_admin_user_unpublish(uid)
        if parts[1] == "revoke-sessions":
          return self._h_admin_user_revoke_sessions(uid)
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._error(HTTPStatus.NOT_FOUND, "not found")

  def do_PUT(self):
    path = urlparse(self.path).path
    if path == "/api/places":
      return self._h_places_update()
    if path == "/api/me/prefs":
      return self._h_prefs_put()
    if path == "/api/metadata":
      return self._h_metadata_put()
    if path == "/api/me/category-labels":
      return self._h_me_category_labels_put()
    self._error(HTTPStatus.NOT_FOUND, "not found")

  def do_DELETE(self):
    path = urlparse(self.path).path
    if path == "/api/places":
      return self._h_places_delete()
    if path == "/api/gpx":
      return self._h_gpx_delete()
    if path.startswith("/api/admin/users/"):
      rest = path[len("/api/admin/users/"):]
      if rest.isdigit():
        return self._h_admin_user_delete(int(rest))
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._error(HTTPStatus.NOT_FOUND, "not found")

  # ---- handlers ----

  def _h_state(self):
    user = self._current_user()
    published = False
    if user:
      published = user_published(self.conn, user["username"])
    self._send_json(HTTPStatus.OK, {
      "authenticated": bool(user),
      "username": user["username"] if user else None,
      "is_admin": bool(user["is_admin"]) if user else False,
      "published": published,
      "registration_open": registration_open(self.conn),
      "publishing_open": publishing_open(self.conn),
      "has_users": user_count(self.conn) > 0,
      "requires_setup_token": Handler.setup_token is not None and user_count(self.conn) == 0,
    })

  def _h_register(self):
    body = self._read_body_or_400()
    if body is None:
      return
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    if not _valid_username(username):
      return self._error(HTTPStatus.BAD_REQUEST, "invalid username (1-64 chars, alphanumerics, '-', '_')")
    if not _valid_password(password):
      return self._error(HTTPStatus.BAD_REQUEST, f"password must be {PASSWORD_MIN}-{PASSWORD_MAX} characters")

    # Serialize the check + insert so two parallel registrations against an
    # empty DB can't both win.
    supplied_token = (body.get("setup_token") or "").strip()
    with self.write_lock:
      if not registration_open(self.conn):
        return self._error(HTTPStatus.FORBIDDEN, "registration is closed")
      if find_user(self.conn, username):
        return self._error(HTTPStatus.CONFLICT, "username taken")
      first_user = user_count(self.conn) == 0
      # First-run setup-token gate: only relevant before the first user exists.
      if first_user and Handler.setup_token is not None:
        if not supplied_token or not secrets.compare_digest(supplied_token, Handler.setup_token):
          return self._error(HTTPStatus.FORBIDDEN, "setup token required or incorrect")
      user_id = create_user(self.conn, username, password, is_admin=first_user)
      token = session_create(self.conn, user_id, ip=self._client_ip(), user_agent=self.headers.get("User-Agent"))
      if first_user:
        Handler.setup_token = None  # Token no longer relevant.
    ensure_user_dir(self.cfg, username)
    cookie = self._set_session_cookie(token, SESSION_DAYS * 86400)
    self._send_json(HTTPStatus.CREATED, {"username": username, "is_admin": first_user}, [cookie])

  def _h_login(self):
    ip = self._client_ip()
    if self.login_limiter.is_blocked(ip):
      return self._error(HTTPStatus.TOO_MANY_REQUESTS, "too many failed login attempts; try again later")
    body = self._read_body_or_400()
    if body is None:
      return
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    user = find_user(self.conn, username)
    if not user:
      # Burn equivalent CPU so timing doesn't leak username existence.
      dummy_verify(password)
      self.login_limiter.record_failure(ip)
      return self._error(HTTPStatus.UNAUTHORIZED, "invalid credentials")
    if not verify_password(password, user["pw_salt"], user["pw_hash"]):
      self.login_limiter.record_failure(ip)
      return self._error(HTTPStatus.UNAUTHORIZED, "invalid credentials")
    self.login_limiter.clear(ip)
    token = session_create(self.conn, user["id"], ip=ip, user_agent=self.headers.get("User-Agent"))
    cookie = self._set_session_cookie(token, SESSION_DAYS * 86400)
    self._send_json(HTTPStatus.OK, {"username": user["username"], "is_admin": bool(user["is_admin"])}, [cookie])

  def _h_logout(self):
    token = self._cookie_token()
    if token:
      session_delete(self.conn, token)
    cookie = self._set_session_cookie("", 0)
    self._send_json(HTTPStatus.OK, {"ok": True}, [cookie])

  def _h_change_password(self):
    user = self._current_user()
    if not user:
      return self._error(HTTPStatus.UNAUTHORIZED, "not authenticated")
    body = self._read_body_or_400()
    if body is None:
      return
    current = body.get("current_password") or ""
    new_pw = body.get("new_password") or ""
    row = self.conn.execute("SELECT pw_salt, pw_hash FROM users WHERE id=?", (user["id"],)).fetchone()
    if not verify_password(current, row["pw_salt"], row["pw_hash"]):
      return self._error(HTTPStatus.UNAUTHORIZED, "current password is wrong")
    if not _valid_password(new_pw):
      return self._error(HTTPStatus.BAD_REQUEST, f"password must be {PASSWORD_MIN}-{PASSWORD_MAX} characters")
    salt, digest = hash_password(new_pw)
    current_token = self._cookie_token()
    with self.write_lock:
      self.conn.execute("UPDATE users SET pw_salt=?, pw_hash=? WHERE id=?", (salt, digest, user["id"]))
      # Invalidate every other session for this user; keep the current one.
      self.conn.execute(
        "DELETE FROM sessions WHERE user_id=? AND token!=?",
        (user["id"], current_token),
      )
    self._send_json(HTTPStatus.OK, {"ok": True})

  def _h_sessions_list(self):
    user = self._current_user()
    if not user:
      return self._error(HTTPStatus.UNAUTHORIZED, "not authenticated")
    current_token = self._cookie_token()
    rows = self.conn.execute(
      "SELECT token, created_at, expires_at, last_seen_at, ip, user_agent "
      "FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC, created_at DESC",
      (user["id"],),
    ).fetchall()
    out = []
    for r in rows:
      out.append({
        "id": r["token"][:12],  # short opaque handle, enough for the revoke call
        "current": r["token"] == current_token,
        "created_at": r["created_at"],
        "expires_at": r["expires_at"],
        "last_seen_at": r["last_seen_at"],
        "ip": r["ip"],
        "user_agent": r["user_agent"],
      })
    self._send_json(HTTPStatus.OK, {"sessions": out})

  def _h_sessions_revoke(self):
    user = self._current_user()
    if not user:
      return self._error(HTTPStatus.UNAUTHORIZED, "not authenticated")
    body = self._read_body_or_400()
    if body is None:
      return
    target = (body.get("id") or "").strip()
    if not target or len(target) != 12:
      return self._error(HTTPStatus.BAD_REQUEST, "id required (12-char prefix from /api/sessions)")
    current_token = self._cookie_token()
    with self.write_lock:
      # Match by token-prefix, scoped to this user, never the current session.
      self.conn.execute(
        "DELETE FROM sessions WHERE user_id=? AND substr(token, 1, 12)=? AND token!=?",
        (user["id"], target, current_token),
      )
    self._send_json(HTTPStatus.OK, {"ok": True})

  def _h_sessions_revoke_others(self):
    user = self._current_user()
    if not user:
      return self._error(HTTPStatus.UNAUTHORIZED, "not authenticated")
    current_token = self._cookie_token()
    with self.write_lock:
      cur = self.conn.execute(
        "DELETE FROM sessions WHERE user_id=? AND token!=?",
        (user["id"], current_token),
      )
      removed = cur.rowcount
    self._send_json(HTTPStatus.OK, {"ok": True, "removed": removed})

  def _h_settings_registration(self):
    if self._require_admin() is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    mode = body.get("mode")
    if mode not in ("open", "closed"):
      return self._error(HTTPStatus.BAD_REQUEST, "mode must be 'open' or 'closed'")
    with self.write_lock:
      setting_set(self.conn, "registration", mode)
    self._send_json(HTTPStatus.OK, {"registration": mode})

  def _h_admin_settings_publishing(self):
    if self._require_admin() is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    mode = body.get("mode")
    if mode not in ("open", "closed"):
      return self._error(HTTPStatus.BAD_REQUEST, "mode must be 'open' or 'closed'")
    with self.write_lock:
      setting_set(self.conn, "publishing", mode)
    self._send_json(HTTPStatus.OK, {"publishing": mode})

  def _admin_user_row(self, row: sqlite3.Row) -> dict:
    uname = row["username"]
    udir = user_dir(self.cfg, uname)
    sessions = self.conn.execute(
      "SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND expires_at > ?",
      (row["id"], int(time.time())),
    ).fetchone()["n"]
    return {
      "id": row["id"],
      "username": uname,
      "is_admin": bool(row["is_admin"]),
      "published": bool(row["published"]),
      "created_at": row["created_at"],
      "sessions": sessions,
      "places": count_user_places(udir),
      "trails": count_user_trails(udir),
    }

  def _h_admin_users_list(self):
    if self._require_admin() is None:
      return
    rows = self.conn.execute(
      "SELECT id, username, is_admin, published, created_at FROM users ORDER BY id"
    ).fetchall()
    out = [self._admin_user_row(r) for r in rows]
    self._send_json(HTTPStatus.OK, {"users": out})

  def _h_admin_stats(self):
    if self._require_admin() is None:
      return
    users = user_count(self.conn)
    published_users = self.conn.execute(
      "SELECT COUNT(*) AS n FROM users WHERE published=1"
    ).fetchone()["n"]
    data_dir = Path(self.cfg["data_dir"]).resolve()
    users_root = data_dir / "users"
    places_total = 0
    trails_total = 0
    if users_root.exists():
      for child in users_root.iterdir():
        if not child.is_dir():
          continue
        places_total += count_user_places(child)
        trails_total += count_user_trails(child)
    db_path = Path(self.cfg["db_path"]).resolve()
    try:
      db_bytes = db_path.stat().st_size
    except OSError:
      db_bytes = 0
    data_bytes = dir_size_bytes(users_root)
    self._send_json(HTTPStatus.OK, {
      "users": users,
      "published_users": published_users,
      "places": places_total,
      "trails": trails_total,
      "db_bytes": db_bytes,
      "data_bytes": data_bytes,
    })

  def _h_admin_user_role(self, uid: int):
    admin = self._require_admin()
    if admin is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    val = body.get("is_admin")
    if not isinstance(val, bool):
      return self._error(HTTPStatus.BAD_REQUEST, "is_admin (bool) required")
    target = self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not target:
      return self._error(HTTPStatus.NOT_FOUND, "user not found")
    if not val and target["is_admin"] and admin_count(self.conn) <= 1:
      return self._error(HTTPStatus.CONFLICT, "cannot demote the last admin")
    with self.write_lock:
      self.conn.execute("UPDATE users SET is_admin=? WHERE id=?", (1 if val else 0, uid))
    self._send_json(HTTPStatus.OK, {"ok": True, "is_admin": val})

  def _h_admin_user_unpublish(self, uid: int):
    if self._require_admin() is None:
      return
    target = self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not target:
      return self._error(HTTPStatus.NOT_FOUND, "user not found")
    with self.write_lock:
      set_user_published(self.conn, uid, False)
    self._send_json(HTTPStatus.OK, {"ok": True})

  def _h_admin_unpublish_all(self):
    if self._require_admin() is None:
      return
    with self.write_lock:
      cur = self.conn.execute("UPDATE users SET published=0 WHERE published=1")
      affected = cur.rowcount
    self._send_json(HTTPStatus.OK, {"ok": True, "affected": affected})

  def _h_admin_user_revoke_sessions(self, uid: int):
    if self._require_admin() is None:
      return
    target = self.conn.execute("SELECT id FROM users WHERE id=?", (uid,)).fetchone()
    if not target:
      return self._error(HTTPStatus.NOT_FOUND, "user not found")
    with self.write_lock:
      cur = self.conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
      removed = cur.rowcount
    self._send_json(HTTPStatus.OK, {"ok": True, "removed": removed})

  def _h_admin_user_delete(self, uid: int):
    admin = self._require_admin()
    if admin is None:
      return
    if admin["id"] == uid:
      return self._error(HTTPStatus.CONFLICT, "cannot delete your own account")
    target = self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not target:
      return self._error(HTTPStatus.NOT_FOUND, "user not found")
    if target["is_admin"] and admin_count(self.conn) <= 1:
      return self._error(HTTPStatus.CONFLICT, "cannot delete the last admin")
    uname = target["username"]
    with self.write_lock:
      # Sessions cascade via FK ON DELETE CASCADE.
      self.conn.execute("DELETE FROM users WHERE id=?", (uid,))
    # File cleanup is best-effort. The DB row is gone (so the user can't sign in
    # or be referenced anywhere), but leftover files on disk shouldn't fail
    # silently — log loudly and report back so an admin can clean up by hand.
    cleanup_warning = None
    try:
      udir = user_dir(self.cfg, uname)
      if udir.exists():
        errors: list[str] = []
        def on_error(_func, path, excinfo):  # noqa: ANN001
          errors.append(f"{path}: {excinfo[1]}")
        shutil.rmtree(udir, onerror=on_error)
        if errors:
          cleanup_warning = f"data dir partially removed; {len(errors)} path(s) failed"
          print(f"[atlas-api] delete user {uname}: rmtree errors: {errors}", file=sys.stderr)
        elif udir.exists():
          cleanup_warning = "data dir still present after rmtree"
          print(f"[atlas-api] delete user {uname}: data dir still present", file=sys.stderr)
    except (OSError, ValidationError) as e:
      cleanup_warning = f"data dir cleanup failed: {e}"
      print(f"[atlas-api] delete user {uname}: {e}", file=sys.stderr)
    payload = {"ok": True}
    if cleanup_warning:
      payload["cleanup_warning"] = cleanup_warning
    self._send_json(HTTPStatus.OK, payload)

  def _h_me_category_labels_get(self):
    user = self._require_user()
    if user is None:
      return
    udir = self._user_dir(user["username"])
    try:
      data = load_json_file(udir / "category-labels.json", expected_type=dict, required=False, label="category-labels.json")
    except ValidationError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
    self._send_json(HTTPStatus.OK, {"category_labels": data or {}})

  def _h_me_category_labels_put(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    cleaned = self._clean_category_labels(body.get("category_labels"))
    if isinstance(cleaned, tuple):  # error tuple (status, msg)
      return self._error(cleaned[0], cleaned[1])

    udir = self._user_dir(user["username"])
    labels_path = udir / "category-labels.json"
    lock_path = udir / ".atlas-category-labels.lock"

    def do_update():
      write_json_file(labels_path, cleaned)

    try:
      with_file_lock(lock_path, do_update)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write category-labels.json: {e}")

    self._send_json(HTTPStatus.OK, {"ok": True, "category_labels": cleaned})

  def _clean_category_labels(self, labels):
    """Validate and normalize a category_labels payload. Returns the cleaned
    dict, or a (status, message) tuple for the caller to turn into an error."""
    if not isinstance(labels, dict):
      return (HTTPStatus.BAD_REQUEST, "category_labels must be an object")
    if len(labels) > 200:
      return (HTTPStatus.BAD_REQUEST, "too many category labels (max 200)")
    cleaned: dict[str, str] = {}
    for slug, display in labels.items():
      if not isinstance(slug, str) or not isinstance(display, str):
        return (HTTPStatus.BAD_REQUEST, "category_labels keys and values must be strings")
      slug_clean = slug.strip()
      display_clean = display.strip()
      if not slug_clean or not display_clean:
        continue
      if len(slug_clean) > 64:
        return (HTTPStatus.BAD_REQUEST, f"slug too long: {slug_clean[:32]}...")
      if len(display_clean) > 80:
        return (HTTPStatus.BAD_REQUEST, f"display too long for slug '{slug_clean}'")
      if not PATH_COMPONENT_RE.match(slug_clean):
        return (HTTPStatus.BAD_REQUEST, f"slug contains disallowed characters: {slug_clean}")
      cleaned[slug_clean] = display_clean
    return cleaned

  # ---- write endpoints (per-user) ----

  def _h_places_create(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    try:
      place = validate_place(body)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    udir = self._user_dir(user["username"])
    places_path = udir / "places.json"
    lock_path = udir / ".atlas-places.lock"

    def do_append():
      existing = load_json_file(places_path, expected_type=list, required=False, label="places.json")
      existing.append(place)
      write_json_file(places_path, existing)
      return len(existing)

    try:
      total = with_file_lock(lock_path, do_append)
    except ValidationError as e:
      return self._error(HTTPStatus.CONFLICT, str(e))
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write places.json: {e}")

    self._send_json(HTTPStatus.CREATED, {"ok": True, "total_places": total, "place": place})

  def _h_places_update(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    original_name = (body.get("original_name") or "").strip()
    if not original_name:
      return self._error(HTTPStatus.BAD_REQUEST, "original_name required")
    place_payload = body.get("place")
    if not isinstance(place_payload, dict):
      return self._error(HTTPStatus.BAD_REQUEST, "place required")
    try:
      validated = validate_place(place_payload)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    udir = self._user_dir(user["username"])
    places_path = udir / "places.json"
    lock_path = udir / ".atlas-places.lock"

    def do_update():
      existing = load_json_file(places_path, expected_type=list, required=True, label="places.json")
      # Locate by name (unique-ish; we update first match).
      idx = next((i for i, p in enumerate(existing) if isinstance(p, dict) and p.get("name") == original_name), None)
      if idx is None:
        raise ValidationError(f"place not found: {original_name}")
      # If renaming, ensure no collision with another row.
      if validated["name"] != original_name and any(p.get("name") == validated["name"] for i, p in enumerate(existing) if i != idx):
        raise ValidationError(f"a different place already uses the name '{validated['name']}'")
      existing[idx] = validated
      write_json_file(places_path, existing)

    try:
      with_file_lock(lock_path, do_update)
    except ValidationError as e:
      status = HTTPStatus.NOT_FOUND if "not found" in str(e) else HTTPStatus.CONFLICT
      return self._error(status, str(e))
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write places.json: {e}")
    self._send_json(HTTPStatus.OK, {"ok": True, "place": validated})

  def _h_places_clear_category(self):
    """Bulk-clear `category` from every place that has the given value. Used
    by the Manage categories UI when the user removes a category that's still
    in use; those places become uncategorized rather than blocking the remove."""
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    target = body.get("category")
    if not isinstance(target, str) or not target.strip():
      return self._error(HTTPStatus.BAD_REQUEST, "category required")
    target = target.strip()

    udir = self._user_dir(user["username"])
    places_path = udir / "places.json"
    lock_path = udir / ".atlas-places.lock"

    def do_clear():
      existing = load_json_file(places_path, expected_type=list, required=False, label="places.json")
      cleared = 0
      for p in existing:
        if isinstance(p, dict) and p.get("category") == target:
          p.pop("category", None)
          cleared += 1
      if cleared:
        write_json_file(places_path, existing)
      return cleared

    try:
      cleared = with_file_lock(lock_path, do_clear)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write places.json: {e}")
    self._send_json(HTTPStatus.OK, {"ok": True, "cleared": cleared})

  def _h_places_delete(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    target_name = (body.get("name") or "").strip()
    if not target_name:
      return self._error(HTTPStatus.BAD_REQUEST, "name required")

    udir = self._user_dir(user["username"])
    places_path = udir / "places.json"
    lock_path = udir / ".atlas-places.lock"

    def do_delete():
      existing = load_json_file(places_path, expected_type=list, required=True, label="places.json")
      original_count = len(existing)
      new_list = [p for p in existing if not (isinstance(p, dict) and p.get("name") == target_name)]
      if len(new_list) == original_count:
        raise ValidationError(f"place not found: {target_name}")
      write_json_file(places_path, new_list)
      return len(new_list)

    try:
      total = with_file_lock(lock_path, do_delete)
    except ValidationError as e:
      status = HTTPStatus.NOT_FOUND if "not found" in str(e) else HTTPStatus.CONFLICT
      return self._error(status, str(e))
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write places.json: {e}")
    self._send_json(HTTPStatus.OK, {"ok": True, "total_places": total})

  def _h_gpx_delete(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    # Region is optional. Empty/missing means a root-level GPX (no region).
    raw_region = body.get("region") or ""
    try:
      region = safe_path_component(raw_region) if raw_region else ""
      name = safe_path_component(body.get("name") or "")
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, f"invalid region/name: {e}")
    if name.lower().endswith(".gpx"):
      name = name[:-4]

    udir = self._user_dir(user["username"])
    gpx_root = udir / "gpx"
    parts = (region, name + ".gpx") if region else (name + ".gpx",)
    planned_parts = (region, name + ".planned.gpx") if region else (name + ".planned.gpx",)
    try:
      target = resolve_under(gpx_root, *parts)
      planned = resolve_under(gpx_root, *planned_parts)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    lock_path = udir / ".atlas-gpx.lock"
    removed = []

    def do_delete():
      for p in (target, planned):
        if p.exists() and p.is_file():
          try:
            p.unlink()
            removed.append(p.name)
          except OSError as e:
            raise ValidationError(f"failed to delete {p.name}: {e}")
      # Best-effort: prune now-empty region dir. Only applies when a region was given.
      if region:
        try:
          region_dir = target.parent
          if region_dir.exists() and region_dir != gpx_root and not any(region_dir.iterdir()):
            region_dir.rmdir()
        except OSError:
          pass

    try:
      with_file_lock(lock_path, do_delete)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))
    if not removed:
      return self._error(HTTPStatus.NOT_FOUND, "no matching GPX file")
    manifest_status = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {"ok": True, "removed": removed, "manifest": manifest_status})

  def _h_gpx_upload(self):
    user = self._require_user()
    if user is None:
      return

    qs = parse_qs(urlparse(self.path).query)
    raw_region = (qs.get("region") or [""])[0]
    try:
      region = safe_path_component(raw_region) if raw_region else ""
      name = safe_path_component((qs.get("name") or [""])[0])
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, f"invalid region/name: {e}")
    if name.lower().endswith(".gpx"):
      name = name[:-4]
    # Opt-in PII stripping (timestamps, author, creator). Off by default so the
    # client decides; the upload UI exposes the toggle.
    strip_pii = (qs.get("strip_pii") or ["false"])[0].lower() in ("true", "1", "yes")

    try:
      raw = self._read_raw(GPX_MAX_BYTES)
    except BodyTooLarge as e:
      return self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f"body too large ({e.length} > {e.cap})")
    except ValueError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))
    if not raw:
      return self._error(HTTPStatus.BAD_REQUEST, "empty body")

    try:
      if strip_pii:
        cleaned = strip_gpx_pii(raw)
      else:
        validate_gpx(raw)
        cleaned = raw
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    udir = self._user_dir(user["username"])
    gpx_root = udir / "gpx"
    parts = (region, name + ".gpx") if region else (name + ".gpx",)
    try:
      target = resolve_under(gpx_root, *parts)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    lock_path = udir / ".atlas-gpx.lock"

    def do_write():
      target.parent.mkdir(parents=True, exist_ok=True)
      atomic_write_bytes(target, cleaned)

    try:
      with_file_lock(lock_path, do_write)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write GPX: {e}")

    manifest_status = self._regenerate_manifest(udir)
    saved_rel = f"gpx/{region}/{name}.gpx" if region else f"gpx/{name}.gpx"
    self._send_json(HTTPStatus.CREATED, {
      "ok": True,
      "saved": saved_rel,
      "bytes": len(cleaned),
      "manifest": manifest_status,
    })

  def _h_region_rename(self):
    """Rename a region: rename the gpx/<from> directory and rewrite any
    metadata.json keys that referenced the old name. Regenerates the manifest."""
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    try:
      old_name = safe_path_component(body.get("from") or "")
      new_name = safe_path_component(body.get("to") or "")
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, f"invalid region name: {e}")
    if old_name == new_name:
      return self._send_json(HTTPStatus.OK, {"ok": True, "renamed": 0})

    udir = self._user_dir(user["username"])
    gpx_root = udir / "gpx"
    try:
      src = resolve_under(gpx_root, old_name)
      dst = resolve_under(gpx_root, new_name)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))
    if not src.exists() or not src.is_dir():
      return self._error(HTTPStatus.NOT_FOUND, f"region not found: {old_name}")
    if dst.exists():
      return self._error(HTTPStatus.CONFLICT, f"region already exists: {new_name}")

    meta_path = udir / "metadata.json"
    lock_path = udir / ".atlas-gpx.lock"
    moved = {"trails": 0, "metadata": 0}

    def do_rename():
      src.rename(dst)
      moved["trails"] = sum(1 for p in dst.glob("*.gpx") if p.is_file())
      if meta_path.exists():
        existing = load_json_file(meta_path, expected_type=dict, required=False, label="metadata.json")
        prefix = old_name + "/"
        updated = {}
        for k, v in existing.items():
          if isinstance(k, str) and k.startswith(prefix):
            updated[new_name + "/" + k[len(prefix):]] = v
            moved["metadata"] += 1
          else:
            updated[k] = v
        if moved["metadata"]:
          write_json_file(meta_path, updated)

    try:
      with_file_lock(lock_path, do_rename)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"rename failed: {e}")
    manifest_status = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {
      "ok": True, "from": old_name, "to": new_name,
      "trails": moved["trails"], "metadata": moved["metadata"],
      "manifest": manifest_status,
    })

  def _h_region_clear(self):
    """Move every GPX in gpx/<name>/ up to gpx/ (no-region bucket), rewrite
    matching metadata.json keys, then delete the now-empty directory.
    Refuses with 409 if any move would overwrite an existing root-level file."""
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    try:
      name = safe_path_component(body.get("name") or "")
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, f"invalid region name: {e}")

    udir = self._user_dir(user["username"])
    gpx_root = udir / "gpx"
    try:
      region_dir = resolve_under(gpx_root, name)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))
    if not region_dir.exists() or not region_dir.is_dir():
      return self._error(HTTPStatus.NOT_FOUND, f"region not found: {name}")

    files = sorted(p for p in region_dir.iterdir() if p.is_file() and p.name.endswith(".gpx"))
    conflicts = [p.name for p in files if (gpx_root / p.name).exists()]
    if conflicts:
      return self._error(HTTPStatus.CONFLICT,
                         f"cannot clear: filename(s) already exist at root: {', '.join(conflicts)}")

    meta_path = udir / "metadata.json"
    lock_path = udir / ".atlas-gpx.lock"
    moved = {"trails": 0, "metadata": 0}

    def do_clear():
      for p in files:
        p.rename(gpx_root / p.name)
        # Count one per unique trail base (collapse .planned siblings).
        if not p.name.endswith(".planned.gpx"):
          moved["trails"] += 1
      # Rewrite metadata keys: "<name>/Trail" -> "Trail"
      if meta_path.exists():
        existing = load_json_file(meta_path, expected_type=dict, required=False, label="metadata.json")
        prefix = name + "/"
        updated = {}
        for k, v in existing.items():
          if isinstance(k, str) and k.startswith(prefix):
            updated[k[len(prefix):]] = v
            moved["metadata"] += 1
          else:
            updated[k] = v
        if moved["metadata"]:
          write_json_file(meta_path, updated)
      # Best-effort prune.
      try:
        if not any(region_dir.iterdir()):
          region_dir.rmdir()
      except OSError:
        pass

    try:
      with_file_lock(lock_path, do_clear)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"clear failed: {e}")
    manifest_status = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {
      "ok": True, "name": name,
      "trails": moved["trails"], "metadata": moved["metadata"],
      "manifest": manifest_status,
    })

  def _h_region_delete(self):
    """Delete an empty region directory. Refuses if any files remain."""
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    try:
      name = safe_path_component(body.get("name") or "")
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, f"invalid region name: {e}")

    udir = self._user_dir(user["username"])
    gpx_root = udir / "gpx"
    try:
      target = resolve_under(gpx_root, name)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))
    if not target.exists() or not target.is_dir():
      return self._error(HTTPStatus.NOT_FOUND, f"region not found: {name}")
    if any(target.iterdir()):
      return self._error(HTTPStatus.CONFLICT, "region not empty")

    lock_path = udir / ".atlas-gpx.lock"

    def do_delete():
      target.rmdir()

    try:
      with_file_lock(lock_path, do_delete)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"delete failed: {e}")
    manifest_status = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {"ok": True, "name": name, "manifest": manifest_status})

  def _regenerate_manifest(self, target_dir: Path) -> dict:
    cmd = self.cfg.get("manifest_cmd")
    if not cmd:
      return {"ran": False, "reason": "no manifest_cmd configured"}
    # Resolve cmd relative to the *original* data_dir (where the script lives)
    # so that switching cwd to a per-user dir doesn't break the path.
    repo_dir = Path(self.cfg["data_dir"]).resolve()
    cmd_path = Path(cmd)
    if not cmd_path.is_absolute():
      cmd_path = (repo_dir / cmd).resolve()
    try:
      proc = subprocess.run(
        [str(cmd_path), str(target_dir)],
        shell=False, check=False, timeout=60, cwd=str(target_dir),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
      )
    except FileNotFoundError:
      return {"ran": False, "reason": f"manifest_cmd not found: {cmd}"}
    except subprocess.TimeoutExpired:
      return {"ran": False, "reason": "manifest_cmd timed out"}
    return {
      "ran": True,
      "exit_code": proc.returncode,
      "stderr_tail": proc.stderr.decode("utf-8", "replace")[-400:],
    }

  # ---- per-user read + account endpoints ----

  def _h_places_get(self):
    user = self._require_user()
    if user is None:
      return
    udir = self._user_dir(user["username"])
    try:
      data = load_json_file(udir / "places.json", expected_type=list, required=False, label="places.json")
    except ValidationError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
    self._send_json(HTTPStatus.OK, data)

  def _h_routes_get(self):
    user = self._require_user()
    if user is None:
      return
    udir = self._user_dir(user["username"])
    try:
      data = load_json_file(udir / "routes.json", expected_type=dict, required=False, label="routes.json")
    except ValidationError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
    self._send_json(HTTPStatus.OK, data or {"regions": []})

  def _h_metadata_get(self):
    user = self._require_user()
    if user is None:
      return
    udir = self._user_dir(user["username"])
    try:
      data = load_json_file(udir / "metadata.json", expected_type=dict, required=False, label="metadata.json")
    except ValidationError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
    self._send_json(HTTPStatus.OK, data or {})

  def _h_metadata_put(self):
    """Upsert metadata for one trail. Body: {key, metadata}. Empty metadata
    deletes the key. Triggers a manifest regen so routes.json picks up the
    change."""
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    key = (body.get("key") or "").strip()
    if not key:
      return self._error(HTTPStatus.BAD_REQUEST, "key required")
    if len(key) > 256:
      return self._error(HTTPStatus.BAD_REQUEST, "key too long")
    # Key shape: "Region/Trail" for regioned trails, or just "Trail" for
    # root-level (no region). Defense in depth; the value never touches the
    # filesystem on this path, but rejecting weird input keeps metadata.json clean.
    parts = key.split("/")
    if len(parts) not in (1, 2):
      return self._error(HTTPStatus.BAD_REQUEST, "key must be 'Region/Trail name' or 'Trail name'")
    try:
      for p in parts:
        safe_path_component(p)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, f"invalid key: {e}")
    try:
      entry = validate_trail_metadata(body.get("metadata") or {})
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    udir = self._user_dir(user["username"])
    meta_path = udir / "metadata.json"
    lock_path = udir / ".atlas-metadata.lock"

    def do_write():
      existing = load_json_file(meta_path, expected_type=dict, required=False, label="metadata.json")
      if entry:
        existing[key] = entry
      else:
        existing.pop(key, None)
      write_json_file(meta_path, existing)
      return existing

    try:
      with_file_lock(lock_path, do_write)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write metadata.json: {e}")
    manifest_status = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {"ok": True, "key": key, "metadata": entry, "manifest": manifest_status})

  def _h_gpx_get(self, region: str, fname: str):
    """Serve an owned GPX file. Path components are validated."""
    user = self._require_user()
    if user is None:
      return
    self._serve_gpx(self._user_dir(user["username"]), region, fname)

  def _h_prefs_get(self):
    user = self._require_user()
    if user is None:
      return
    udir = self._user_dir(user["username"])
    try:
      data = load_json_file(udir / "prefs.json", expected_type=dict, required=False, label="prefs.json")
    except ValidationError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
    self._send_json(HTTPStatus.OK, data or {})

  def _h_prefs_put(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    if not isinstance(body, dict):
      return self._error(HTTPStatus.BAD_REQUEST, "prefs must be an object")
    udir = self._user_dir(user["username"])
    try:
      write_json_file(udir / "prefs.json", body)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write prefs: {e}")
    self._send_json(HTTPStatus.OK, {"ok": True})

  def _h_publish_post(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    val = body.get("published")
    if not isinstance(val, bool):
      return self._error(HTTPStatus.BAD_REQUEST, "published (bool) required")
    # Non-admins can always unpublish, but can only publish when the global
    # flag is open. Admins bypass the gate so they can manage their own state.
    if val and not user["is_admin"] and not publishing_open(self.conn):
      return self._error(HTTPStatus.FORBIDDEN, "publishing is disabled by the admin")
    with self.write_lock:
      set_user_published(self.conn, user["id"], val)
    self._send_json(HTTPStatus.OK, {"ok": True, "published": val})

  def _h_export_get(self):
    user = self._require_user()
    if user is None:
      return
    udir = self._user_dir(user["username"])
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
      # followlinks=True so a symlinked gpx/ dir (the documented dev pattern)
      # is included. Path.rglob silently skips into symlinked directories.
      for root, dirs, files in os.walk(udir, followlinks=True):
        dirs.sort()
        root_p = Path(root)
        for fname in sorted(files):
          if fname.startswith("."):
            continue  # locks (.atlas-*), OS noise (.DS_Store, etc.)
          path = root_p / fname
          zf.write(path, arcname=str(path.relative_to(udir)))
    payload = buf.getvalue()
    fname = f"atlas-{user['username']}-export.zip"
    self.send_response(HTTPStatus.OK)
    self.send_header("Content-Type", "application/zip")
    self.send_header("Content-Length", str(len(payload)))
    self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    self.wfile.write(payload)

  def _h_import_post(self):
    user = self._require_user()
    if user is None:
      return

    qs = parse_qs(urlparse(self.path).query)
    mode = (qs.get("mode") or ["replace"])[0]
    if mode not in ("replace", "merge"):
      return self._error(HTTPStatus.BAD_REQUEST, "mode must be 'replace' or 'merge'")

    ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip()
    if ctype not in ("application/zip", "application/octet-stream"):
      return self._error(HTTPStatus.BAD_REQUEST, "expected application/zip body")

    try:
      raw = self._read_raw(IMPORT_MAX_BYTES)
    except BodyTooLarge as e:
      return self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f"body too large ({e.length} > {e.cap})")
    except ValueError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))
    if not raw:
      return self._error(HTTPStatus.BAD_REQUEST, "empty body")

    try:
      zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as e:
      return self._error(HTTPStatus.BAD_REQUEST, f"invalid zip: {e}")

    staged: dict[str, bytes] = {}
    total_uncompressed = 0
    for info in zf.infolist():
      if info.is_dir():
        continue
      name = info.filename
      if name.startswith("/") or "\\" in name or ".." in name.split("/"):
        return self._error(HTTPStatus.BAD_REQUEST, f"invalid entry: {name}")
      parts = name.split("/")
      if name in IMPORT_TOP_FILES:
        pass
      elif len(parts) == 3 and parts[0] == "gpx" and parts[2].endswith(".gpx"):
        try:
          safe_path_component(parts[1])
          safe_path_component(parts[2][:-4])
        except ValidationError as e:
          return self._error(HTTPStatus.BAD_REQUEST, f"invalid gpx path '{name}': {e}")
      elif len(parts) == 2 and parts[0] == "gpx" and parts[1].endswith(".gpx"):
        # Root-level GPX (no region).
        try:
          safe_path_component(parts[1][:-4])
        except ValidationError as e:
          return self._error(HTTPStatus.BAD_REQUEST, f"invalid gpx path '{name}': {e}")
      else:
        return self._error(HTTPStatus.BAD_REQUEST, f"unexpected file in zip: {name}")
      total_uncompressed += info.file_size
      if total_uncompressed > IMPORT_MAX_UNCOMPRESSED:
        return self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "uncompressed size exceeds limit")
      try:
        with zf.open(info) as fh:
          staged[name] = fh.read()
      except Exception as e:
        return self._error(HTTPStatus.BAD_REQUEST, f"failed reading {name}: {e}")

    def parse_json(arcname: str, expected_type: type):
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

    try:
      new_places = parse_json("places.json", list)
      new_routes = parse_json("routes.json", dict)
      new_metadata = parse_json("metadata.json", dict)
      new_prefs = parse_json("prefs.json", dict)
      new_labels = parse_json("category-labels.json", dict)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    if new_labels is not None:
      cleaned_labels = self._clean_category_labels(new_labels)
      if isinstance(cleaned_labels, tuple):
        return self._error(cleaned_labels[0], f"category-labels.json: {cleaned_labels[1]}")
      # Re-stage the cleaned form so the writer below uses the canonical bytes.
      staged["category-labels.json"] = (json.dumps(cleaned_labels, ensure_ascii=False, indent=2) + "\n").encode("utf-8")

    if new_places is not None:
      for i, p in enumerate(new_places):
        try:
          validate_place(p)
        except ValidationError as e:
          return self._error(HTTPStatus.BAD_REQUEST, f"places.json[{i}]: {e}")

    cleaned_gpx: dict[str, bytes] = {}
    for arcname, data in staged.items():
      if not arcname.startswith("gpx/"):
        continue
      try:
        cleaned_gpx[arcname] = strip_gpx_pii(data)
      except ValidationError as e:
        return self._error(HTTPStatus.BAD_REQUEST, f"{arcname}: {e}")

    udir = self._user_dir(user["username"])
    lock_path = udir / ".atlas-import.lock"

    def do_import():
      if mode == "replace":
        for name in IMPORT_TOP_FILES:
          p = udir / name
          if p.exists():
            p.unlink()
        gpx_root = udir / "gpx"
        if gpx_root.exists():
          shutil.rmtree(gpx_root)
        for arcname in IMPORT_TOP_FILES:
          if arcname in staged:
            atomic_write_bytes(udir / arcname, staged[arcname])
        for arcname, data in cleaned_gpx.items():
          target = udir / arcname
          target.parent.mkdir(parents=True, exist_ok=True)
          atomic_write_bytes(target, data)
        return {
          "added_places": len(new_places or []),
          "changed_meta": len(new_metadata or {}),
          "changed_prefs": len(new_prefs or {}),
        }
      # merge
      added = 0
      if new_places is not None:
        places_path = udir / "places.json"
        existing = load_json_file(places_path, expected_type=list, required=False, label="places.json")
        existing_names = {p.get("name") for p in existing if isinstance(p, dict)}
        for p in new_places:
          if p.get("name") not in existing_names:
            existing.append(p)
            existing_names.add(p.get("name"))
            added += 1
        write_json_file(places_path, existing)
      changed_meta = 0
      if new_metadata is not None:
        meta_path = udir / "metadata.json"
        existing = load_json_file(meta_path, expected_type=dict, required=False, label="metadata.json")
        changed_meta = sum(1 for k, v in new_metadata.items() if existing.get(k) != v)
        existing.update(new_metadata)
        write_json_file(meta_path, existing)
      changed_prefs = 0
      if new_prefs is not None:
        prefs_path = udir / "prefs.json"
        existing = load_json_file(prefs_path, expected_type=dict, required=False, label="prefs.json")
        changed_prefs = sum(1 for k, v in new_prefs.items() if existing.get(k) != v)
        existing.update(new_prefs)
        write_json_file(prefs_path, existing)
      if new_labels is not None:
        labels_path = udir / "category-labels.json"
        existing = load_json_file(labels_path, expected_type=dict, required=False, label="category-labels.json")
        existing.update(cleaned_labels)
        write_json_file(labels_path, existing)
      for arcname, data in cleaned_gpx.items():
        target = udir / arcname
        target.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(target, data)
      return {"added_places": added, "changed_meta": changed_meta, "changed_prefs": changed_prefs}

    try:
      result = with_file_lock(lock_path, do_import)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"import failed: {e}")

    manifest = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {
      "ok": True,
      "mode": mode,
      "imported": {
        "places": result["added_places"],
        "gpx": len(cleaned_gpx),
        "metadata": result["changed_meta"],
        "prefs": result["changed_prefs"],
      },
      "manifest": manifest,
    })

  # ---- public read endpoints under /api/u/<username>/ ----

  def _public_user_dir(self, username: str) -> Path | None:
    """Return the user dir iff that user exists and has publish=ON. Else None
    (caller should 404). Username is sanitized as a path component too."""
    try:
      safe_path_component(username)
    except ValidationError:
      return None
    if not user_published(self.conn, username):
      return None
    try:
      return user_dir(self.cfg, username)
    except ValidationError:
      return None

  def _h_public_places(self, username: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    try:
      data = load_json_file(udir / "places.json", expected_type=list, required=False, label="places.json")
    except ValidationError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
    self._send_json(HTTPStatus.OK, data)

  def _h_public_routes(self, username: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    try:
      data = load_json_file(udir / "routes.json", expected_type=dict, required=False, label="routes.json")
    except ValidationError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
    self._send_json(HTTPStatus.OK, data or {"regions": []})

  def _h_public_metadata(self, username: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    try:
      data = load_json_file(udir / "metadata.json", expected_type=dict, required=False, label="metadata.json")
    except ValidationError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
    self._send_json(HTTPStatus.OK, data or {})

  def _h_public_category_labels(self, username: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    try:
      data = load_json_file(udir / "category-labels.json", expected_type=dict, required=False, label="category-labels.json")
    except ValidationError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
    self._send_json(HTTPStatus.OK, {"category_labels": data or {}})

  def _h_public_gpx(self, username: str, region: str, fname: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._serve_gpx(udir, region, fname)

  def _serve_gpx(self, udir: Path, region: str, fname: str):
    try:
      region_safe = safe_path_component(region) if region else ""
      file_safe = safe_path_component(fname)
    except ValidationError:
      return self._error(HTTPStatus.BAD_REQUEST, "invalid path")
    if not file_safe.lower().endswith(".gpx"):
      return self._error(HTTPStatus.BAD_REQUEST, "expected .gpx")
    parts = (region_safe, file_safe) if region_safe else (file_safe,)
    try:
      target = resolve_under(udir / "gpx", *parts)
    except ValidationError:
      return self._error(HTTPStatus.BAD_REQUEST, "invalid path")
    if not target.exists() or not target.is_file():
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    try:
      data = target.read_bytes()
    except OSError:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "read failed")
    self.send_response(HTTPStatus.OK)
    self.send_header("Content-Type", "application/gpx+xml")
    self.send_header("Content-Length", str(len(data)))
    self.send_header("Cache-Control", "no-cache")
    self.end_headers()
    self.wfile.write(data)


class BodyTooLarge(Exception):
  def __init__(self, length: int, cap: int):
    super().__init__(f"body too large: {length} > {cap}")
    self.length = length
    self.cap = cap


def _valid_username(name: str) -> bool:
  if not name or len(name) > USERNAME_MAX:
    return False
  return name.replace("_", "").replace("-", "").isalnum()


def _valid_password(pw: str) -> bool:
  return PASSWORD_MIN <= len(pw) <= PASSWORD_MAX


# ---------- file + write helpers ----------

class ValidationError(Exception):
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


def resolve_under(base: Path, *parts: str) -> Path:
  """Join base with sanitized components, then assert the result stays inside."""
  candidate = base.joinpath(*parts).resolve()
  base_resolved = base.resolve()
  if base_resolved != candidate and base_resolved not in candidate.parents:
    raise ValidationError("path escapes base directory")
  return candidate


def write_json_file(path: Path, data) -> None:
  """Serialize `data` as pretty JSON with trailing newline and write atomically."""
  atomic_write_bytes(path, (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


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
  fd, tmp_path = tempfile.mkstemp(prefix=".atlas-", dir=parent)
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


def with_file_lock(lock_path: Path, fn):
  """Run fn() while holding an exclusive flock on lock_path. Creates the file if needed."""
  lock_path.parent.mkdir(parents=True, exist_ok=True)
  with open(lock_path, "a+") as lf:
    fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
    try:
      return fn()
    finally:
      fcntl.flock(lf.fileno(), fcntl.LOCK_UN)


# ---------- place validation ----------

def validate_place(p: object) -> dict:
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
  # Category is optional. An empty string or missing field both mean
  # "uncategorized" and are stripped from the stored object.
  category = p.get("category")
  if category is not None and category != "":
    if not isinstance(category, str) or not category.strip() or len(category) > 64:
      raise ValidationError("category, when set, must be a non-empty string (<=64 chars)")
  if "country" in p and p["country"] is not None and not (isinstance(p["country"], str) and len(p["country"]) <= 100):
    raise ValidationError("country must be a string (<=100 chars) or null")
  if "visited" in p and not isinstance(p["visited"], bool):
    raise ValidationError("visited must be boolean")
  if "note" in p and p["note"] is not None and not (isinstance(p["note"], str) and len(p["note"]) <= 2000):
    raise ValidationError("note must be a string (<=2000 chars) or null")
  if "local_name" in p and p["local_name"] is not None and not (isinstance(p["local_name"], str) and len(p["local_name"]) <= 200):
    raise ValidationError("local_name must be a string (<=200 chars) or null")
  if "date_visited" in p and p["date_visited"] is not None and p["date_visited"] != "":
    if not isinstance(p["date_visited"], str) or not TRAIL_DATE_RE.match(p["date_visited"]):
      raise ValidationError("date_visited must be YYYY-MM-DD")
  if "rating" in p and p["rating"] is not None and p["rating"] != "":
    r = p["rating"]
    if isinstance(r, bool) or not isinstance(r, int) or not 1 <= r <= 5:
      raise ValidationError("rating must be an integer 1-5")
  if "sources" in p:
    if not isinstance(p["sources"], list) or len(p["sources"]) > 20:
      raise ValidationError("sources must be a list (<=20 items)")
    for s in p["sources"]:
      if not isinstance(s, str) or len(s) > 500:
        raise ValidationError("each source must be a string (<=500 chars)")
      if urlparse(s).scheme.lower() not in ("http", "https"):
        raise ValidationError("each source must be an http(s) URL")
  # Return a normalized copy: trimmed strings, defaulted booleans.
  out = {
    "name": name.strip(),
    "lat": float(lat),
    "lon": float(lon),
    "visited": bool(p.get("visited", False)),
  }
  if category is not None and category != "":
    out["category"] = category.strip()
  for k in ("country", "note", "local_name", "sources"):
    if k in p and p[k] is not None:
      out[k] = p[k].strip() if isinstance(p[k], str) else p[k]
  if "date_visited" in p and p["date_visited"]:
    out["date_visited"] = p["date_visited"]
  if "rating" in p and p["rating"] not in (None, ""):
    out["rating"] = p["rating"]
  return out


def validate_trail_metadata(m: object) -> dict:
  """Validate a per-trail metadata payload. Returns a normalized dict containing
  only the fields that have a non-empty value. Raises ValidationError on any
  invalid input."""
  if not isinstance(m, dict):
    raise ValidationError("metadata must be an object")
  unknown = set(m.keys()) - TRAIL_META_FIELDS
  if unknown:
    raise ValidationError(f"unknown fields: {sorted(unknown)}")
  out: dict = {}

  src = m.get("source")
  if src is not None and src != "":
    if not isinstance(src, str):
      raise ValidationError("source must be a string")
    s = src.strip()
    if s:
      if len(s) > 500:
        raise ValidationError("source too long (max 500 chars)")
      try:
        parsed = urlparse(s)
      except ValueError:
        raise ValidationError("source is not a valid URL")
      if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValidationError("source must be an http or https URL")
      out["source"] = s

  d = m.get("date_hiked")
  if d is not None and d != "":
    if not isinstance(d, str) or not TRAIL_DATE_RE.match(d):
      raise ValidationError("date_hiked must be YYYY-MM-DD")
    out["date_hiked"] = d

  r = m.get("rating")
  if r is not None and r != "":
    if isinstance(r, bool) or not isinstance(r, int) or not 1 <= r <= 5:
      raise ValidationError("rating must be an integer 1-5")
    out["rating"] = r

  n = m.get("notes")
  if n is not None and n != "":
    if not isinstance(n, str):
      raise ValidationError("notes must be a string")
    ns = n.strip()
    if ns:
      if len(ns) > 2000:
        raise ValidationError("notes too long (max 2000 chars)")
      out["notes"] = ns

  tags = m.get("tags")
  if tags:
    if not isinstance(tags, list):
      raise ValidationError("tags must be a list of strings")
    cleaned: list[str] = []
    seen: set[str] = set()
    for t in tags:
      if not isinstance(t, str):
        raise ValidationError("each tag must be a string")
      tn = t.strip().lower()
      if not tn:
        continue
      if not TRAIL_TAG_RE.match(tn):
        raise ValidationError(f"invalid tag: {tn!r} (lowercase alphanumerics + hyphen, 1-32 chars, starts with alphanumeric)")
      if tn not in seen:
        seen.add(tn)
        cleaned.append(tn)
    if len(cleaned) > 10:
      raise ValidationError("too many tags (max 10)")
    if cleaned:
      out["tags"] = cleaned

  diff = m.get("difficulty")
  if diff is not None and diff != "":
    if diff not in TRAIL_DIFFICULTIES:
      raise ValidationError(f"difficulty must be one of: {', '.join(TRAIL_DIFFICULTIES)}")
    out["difficulty"] = diff

  ln = m.get("local_name")
  if ln is not None and ln != "":
    if not isinstance(ln, str):
      raise ValidationError("local_name must be a string")
    lns = ln.strip()
    if lns:
      if len(lns) > 200:
        raise ValidationError("local_name too long (max 200 chars)")
      out["local_name"] = lns

  return out


# ---------- gpx PII strip + validation ----------

def validate_gpx(xml_bytes: bytes) -> None:
  """Parse to confirm well-formed XML with a <gpx> root. Does not modify."""
  try:
    root = ET.fromstring(xml_bytes)
  except ET.ParseError as e:
    raise ValidationError(f"not valid XML: {e}")
  root_tag = root.tag.split("}", 1)[-1] if "}" in root.tag else root.tag
  if root_tag != "gpx":
    raise ValidationError(f"root element must be <gpx>, got <{root_tag}>")


def strip_gpx_pii(xml_bytes: bytes) -> bytes:
  """Parse GPX, drop <time>/<author> elements and creator= attribute, re-serialize.

  Raises ValidationError if the bytes aren't a valid GPX document.
  """
  for prefix, uri in (
    ("", GPX_NS),
    ("gpx_style", "http://www.topografix.com/GPX/gpx_style/0/2"),
    ("gpxtpx", "http://www.garmin.com/xmlschemas/TrackPointExtension/v1"),
    ("gpxx", "http://www.garmin.com/xmlschemas/GpxExtensions/v3"),
    ("gpxpx", "http://www.garmin.com/xmlschemas/PowerExtension/v1"),
    ("xsi", "http://www.w3.org/2001/XMLSchema-instance"),
  ):
    ET.register_namespace(prefix, uri)
  try:
    root = ET.fromstring(xml_bytes)
  except ET.ParseError as e:
    raise ValidationError(f"not valid XML: {e}")
  root_tag = root.tag.split("}", 1)[-1] if "}" in root.tag else root.tag
  if root_tag != "gpx":
    raise ValidationError(f"root element must be <gpx>, got <{root_tag}>")

  def walk(parent):
    to_remove = []
    for child in parent:
      tag = child.tag.split("}", 1)[-1] if "}" in child.tag else child.tag
      if tag in ("time", "author"):
        to_remove.append(child)
      else:
        walk(child)
    for el in to_remove:
      parent.remove(el)

  if "creator" in root.attrib:
    del root.attrib["creator"]
  walk(root)
  return ET.tostring(root, xml_declaration=True, encoding="UTF-8")


# ---------- server ----------

class ThreadingHTTPServer(http.server.ThreadingHTTPServer):
  daemon_threads = True
  allow_reuse_address = True


def parse_bind(spec: str) -> tuple[str, int]:
  host, _, port = spec.rpartition(":")
  return host or "127.0.0.1", int(port)


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--config", default="tools/config.json", type=Path)
  args = parser.parse_args()

  cfg = load_config(args.config)
  conn = db_connect(cfg["db_path"])
  db_init(conn)
  db_migrate(conn)
  seed_initial_user(conn, cfg)
  migrate_legacy_data(conn, cfg)
  # Ensure every existing user has a data dir (no-op for already-set-up ones).
  for r in conn.execute("SELECT username FROM users").fetchall():
    try:
      ensure_user_dir(cfg, r["username"])
    except ValidationError:
      pass
  # Boot conn is done with; handlers open per-request connections.
  conn.close()

  Handler.cfg = cfg
  Handler.login_limiter = RateLimiter(RATE_LIMIT_MAX_FAILS, RATE_LIMIT_WINDOW)
  Handler.write_lock = threading.Lock()
  Handler.last_request = time.monotonic()

  # Setup token: if enabled and no users exist yet, generate one and require it
  # on /api/register. Print to stderr only; the admin copies it from logs.
  Handler.setup_token = None
  if cfg.get("require_setup_token") and user_count(conn) == 0:
    Handler.setup_token = secrets.token_urlsafe(24)
    print(f"[atlas-api] setup token (required for first registration): {Handler.setup_token}", file=sys.stderr)
    print("[atlas-api] use the 'Setup token' field on the registration page", file=sys.stderr)

  idle_threshold = int(cfg.get("idle_exit_seconds") or 0)
  if idle_threshold > 0:
    def _idle_watcher():
      poll = max(15, min(idle_threshold, 60))
      while True:
        time.sleep(poll)
        if time.monotonic() - Handler.last_request >= idle_threshold:
          print(f"[atlas-api] idle for {idle_threshold}s, exiting", file=sys.stderr)
          os._exit(0)
    threading.Thread(target=_idle_watcher, name="idle-watcher", daemon=True).start()

  host, port = parse_bind(cfg["bind"])

  # Honor systemd socket activation if present (LISTEN_FDS=1 means fd 3 is our socket).
  listen_fds = int(os.environ.get("LISTEN_FDS", "0") or "0")
  if listen_fds:
    sock = socket.socket(fileno=3)
    server = ThreadingHTTPServer((host, port), Handler, bind_and_activate=False)
    server.socket = sock
    server.server_address = sock.getsockname()
    print("[atlas-api] inherited socket fd 3 from systemd", file=sys.stderr)
  else:
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[atlas-api] listening on {host}:{port}", file=sys.stderr)

  try:
    server.serve_forever()
  except KeyboardInterrupt:
    print("[atlas-api] shutting down", file=sys.stderr)
  finally:
    server.server_close()
  return 0


if __name__ == "__main__":
  sys.exit(main())
