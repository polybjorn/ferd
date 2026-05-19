#!/usr/bin/env python3
"""Atlas API server.

Stdlib-only. Provides auth (register/login/logout/change-password/state) backed
by SQLite. Write endpoints land in phase 2.

Run: python3 tools/api.py [--config tools/config.json]
"""

from __future__ import annotations

import argparse
import fcntl
import http.cookies
import http.server
import json
import os
import re
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
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
GPX_NS = "http://www.topografix.com/GPX/1/1"
PATH_COMPONENT_RE = re.compile(r"^[A-Za-z0-9 _.\-()æøåÆØÅäöüÄÖÜ]{1,80}$")
PLACE_REQUIRED = {"name", "lat", "lon", "category"}
PLACE_OPTIONAL = {"country", "visited", "note", "sources", "local_name"}
PLACE_ALL = PLACE_REQUIRED | PLACE_OPTIONAL

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
  """Forward-compatible column adds for sessions table."""
  cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
  if "last_seen_at" not in cols:
    conn.execute("ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0")
  if "ip" not in cols:
    conn.execute("ALTER TABLE sessions ADD COLUMN ip TEXT")
  if "user_agent" not in cols:
    conn.execute("ALTER TABLE sessions ADD COLUMN user_agent TEXT")


def db_init(conn: sqlite3.Connection) -> None:
  conn.executescript("""
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pw_salt BLOB NOT NULL,
      pw_hash BLOB NOT NULL,
      is_operator INTEGER NOT NULL DEFAULT 0,
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


def create_user(conn: sqlite3.Connection, username: str, password: str, is_operator: bool = False) -> int:
  salt, digest = hash_password(password)
  cur = conn.execute(
    "INSERT INTO users(username, pw_salt, pw_hash, is_operator, created_at) VALUES (?, ?, ?, ?, ?)",
    (username, salt, digest, 1 if is_operator else 0, int(time.time())),
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
    create_user(conn, user, pw, is_operator=True)
    print(f"[atlas-api] seeded initial operator '{user}'", file=sys.stderr)


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
    "SELECT u.id AS id, u.username AS username, u.is_operator AS is_operator, "
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
  conn: sqlite3.Connection = None  # set on server
  cfg: dict = None
  login_limiter: RateLimiter = None
  # Serializes read-then-write critical sections across worker threads, since we
  # share one sqlite connection. SQLite gives row-level safety; this gives
  # transaction-level safety without needing per-request connections.
  write_lock: threading.Lock = None
  # Monotonic timestamp of the most recent request; consumed by the idle watcher.
  last_request: float = 0.0
  # Set on startup if `require_setup_token` is enabled and no users exist.
  # Cleared once the first user registers.
  setup_token: str | None = None

  def handle_one_request(self):
    Handler.last_request = time.monotonic()
    return super().handle_one_request()

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

  def _require_operator(self) -> sqlite3.Row | None:
    """Return current user if operator, else send 401/403 and return None."""
    user = self._current_user()
    if not user:
      self._error(HTTPStatus.UNAUTHORIZED, "not authenticated")
      return None
    if not user["is_operator"]:
      self._error(HTTPStatus.FORBIDDEN, "operator only")
      return None
    return user

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
    if path == "/api/gpx":
      return self._h_gpx_upload()
    if path == "/api/sessions/revoke":
      return self._h_sessions_revoke()
    self._error(HTTPStatus.NOT_FOUND, "not found")

  def do_PUT(self):
    path = urlparse(self.path).path
    if path == "/api/places":
      return self._h_places_update()
    if path == "/api/site-config/category-labels":
      return self._h_site_config_category_labels()
    self._error(HTTPStatus.NOT_FOUND, "not found")

  def do_DELETE(self):
    path = urlparse(self.path).path
    if path == "/api/places":
      return self._h_places_delete()
    if path == "/api/gpx":
      return self._h_gpx_delete()
    self._error(HTTPStatus.NOT_FOUND, "not found")

  # ---- handlers ----

  def _h_state(self):
    user = self._current_user()
    self._send_json(HTTPStatus.OK, {
      "authenticated": bool(user),
      "username": user["username"] if user else None,
      "is_operator": bool(user["is_operator"]) if user else False,
      "registration_open": registration_open(self.conn),
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
      user_id = create_user(self.conn, username, password, is_operator=first_user)
      token = session_create(self.conn, user_id, ip=self._client_ip(), user_agent=self.headers.get("User-Agent"))
      if first_user:
        Handler.setup_token = None  # Token no longer relevant.
    cookie = self._set_session_cookie(token, SESSION_DAYS * 86400)
    self._send_json(HTTPStatus.CREATED, {"username": username, "is_operator": first_user}, [cookie])

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
    self._send_json(HTTPStatus.OK, {"username": user["username"], "is_operator": bool(user["is_operator"])}, [cookie])

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

  def _h_settings_registration(self):
    if self._require_operator() is None:
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

  def _h_site_config_category_labels(self):
    if self._require_operator() is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    labels = body.get("category_labels")
    if not isinstance(labels, dict):
      return self._error(HTTPStatus.BAD_REQUEST, "category_labels must be an object")
    if len(labels) > 200:
      return self._error(HTTPStatus.BAD_REQUEST, "too many category labels (max 200)")
    cleaned: dict[str, str] = {}
    for slug, display in labels.items():
      if not isinstance(slug, str) or not isinstance(display, str):
        return self._error(HTTPStatus.BAD_REQUEST, "category_labels keys and values must be strings")
      slug_clean = slug.strip()
      display_clean = display.strip()
      if not slug_clean or not display_clean:
        continue
      if len(slug_clean) > 64:
        return self._error(HTTPStatus.BAD_REQUEST, f"slug too long: {slug_clean[:32]}...")
      if len(display_clean) > 80:
        return self._error(HTTPStatus.BAD_REQUEST, f"display too long for slug '{slug_clean}'")
      if not PATH_COMPONENT_RE.match(slug_clean):
        return self._error(HTTPStatus.BAD_REQUEST, f"slug contains disallowed characters: {slug_clean}")
      cleaned[slug_clean] = display_clean

    data_dir = Path(self.cfg["data_dir"]).resolve()
    config_path = data_dir / "site-config.json"
    lock_path = data_dir / ".atlas-site-config.lock"

    def do_update():
      existing = load_json_file(config_path, expected_type=dict, required=False, label="site-config.json")
      existing["category_labels"] = cleaned
      write_json_file(config_path, existing)

    try:
      with_file_lock(lock_path, do_update)
    except ValidationError as e:
      return self._error(HTTPStatus.CONFLICT, str(e))
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write site-config.json: {e}")

    self._send_json(HTTPStatus.OK, {"ok": True, "category_labels": cleaned})

  # ---- phase 2: write endpoints ----

  def _h_places_create(self):
    if self._require_operator() is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    try:
      place = validate_place(body)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    data_dir = Path(self.cfg["data_dir"]).resolve()
    places_path = data_dir / "places.json"
    lock_path = data_dir / ".atlas-places.lock"

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
    if self._require_operator() is None:
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

    data_dir = Path(self.cfg["data_dir"]).resolve()
    places_path = data_dir / "places.json"
    lock_path = data_dir / ".atlas-places.lock"

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

  def _h_places_delete(self):
    if self._require_operator() is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    target_name = (body.get("name") or "").strip()
    if not target_name:
      return self._error(HTTPStatus.BAD_REQUEST, "name required")

    data_dir = Path(self.cfg["data_dir"]).resolve()
    places_path = data_dir / "places.json"
    lock_path = data_dir / ".atlas-places.lock"

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
    if self._require_operator() is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    try:
      region = safe_path_component(body.get("region") or "")
      name = safe_path_component(body.get("name") or "")
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, f"invalid region/name: {e}")
    if name.lower().endswith(".gpx"):
      name = name[:-4]

    data_dir = Path(self.cfg["data_dir"]).resolve()
    gpx_root = data_dir / "gpx"
    try:
      target = resolve_under(gpx_root, region, name + ".gpx")
      planned = resolve_under(gpx_root, region, name + ".planned.gpx")
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    lock_path = data_dir / ".atlas-gpx.lock"
    removed = []

    def do_delete():
      for p in (target, planned):
        if p.exists() and p.is_file():
          try:
            p.unlink()
            removed.append(p.name)
          except OSError as e:
            raise ValidationError(f"failed to delete {p.name}: {e}")
      # Best-effort: prune now-empty region dir.
      try:
        region_dir = target.parent
        if region_dir.exists() and not any(region_dir.iterdir()):
          region_dir.rmdir()
      except OSError:
        pass

    try:
      with_file_lock(lock_path, do_delete)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))
    if not removed:
      return self._error(HTTPStatus.NOT_FOUND, "no matching GPX file")
    manifest_status = self._regenerate_manifest(data_dir)
    self._send_json(HTTPStatus.OK, {"ok": True, "removed": removed, "manifest": manifest_status})

  def _h_gpx_upload(self):
    if self._require_operator() is None:
      return

    qs = parse_qs(urlparse(self.path).query)
    try:
      region = safe_path_component((qs.get("region") or [""])[0])
      name = safe_path_component((qs.get("name") or [""])[0])
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, f"invalid region/name: {e}")
    if name.lower().endswith(".gpx"):
      name = name[:-4]

    try:
      raw = self._read_raw(GPX_MAX_BYTES)
    except BodyTooLarge as e:
      return self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f"body too large ({e.length} > {e.cap})")
    except ValueError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))
    if not raw:
      return self._error(HTTPStatus.BAD_REQUEST, "empty body")

    try:
      cleaned = strip_gpx_pii(raw)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    data_dir = Path(self.cfg["data_dir"]).resolve()
    gpx_root = data_dir / "gpx"
    try:
      target = resolve_under(gpx_root, region, name + ".gpx")
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    lock_path = data_dir / ".atlas-gpx.lock"

    def do_write():
      target.parent.mkdir(parents=True, exist_ok=True)
      atomic_write_bytes(target, cleaned)

    try:
      with_file_lock(lock_path, do_write)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write GPX: {e}")

    manifest_status = self._regenerate_manifest(data_dir)
    self._send_json(HTTPStatus.CREATED, {
      "ok": True,
      "saved": f"gpx/{region}/{name}.gpx",
      "bytes": len(cleaned),
      "manifest": manifest_status,
    })

  def _regenerate_manifest(self, data_dir: Path) -> dict:
    cmd = self.cfg.get("manifest_cmd")
    if not cmd:
      return {"ran": False, "reason": "no manifest_cmd configured"}
    try:
      proc = subprocess.run(
        [cmd], shell=False, check=False, timeout=60, cwd=str(data_dir),
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


# ---------- phase 2: file + write helpers ----------

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
  category = p["category"]
  if not isinstance(category, str) or not category.strip() or len(category) > 64:
    raise ValidationError("category must be a non-empty string (<=64 chars)")
  if "country" in p and p["country"] is not None and not (isinstance(p["country"], str) and len(p["country"]) <= 100):
    raise ValidationError("country must be a string (<=100 chars) or null")
  if "visited" in p and not isinstance(p["visited"], bool):
    raise ValidationError("visited must be boolean")
  if "note" in p and p["note"] is not None and not (isinstance(p["note"], str) and len(p["note"]) <= 2000):
    raise ValidationError("note must be a string (<=2000 chars) or null")
  if "local_name" in p and p["local_name"] is not None and not (isinstance(p["local_name"], str) and len(p["local_name"]) <= 200):
    raise ValidationError("local_name must be a string (<=200 chars) or null")
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
    "category": category.strip(),
    "visited": bool(p.get("visited", False)),
  }
  for k in ("country", "note", "local_name", "sources"):
    if k in p and p[k] is not None:
      out[k] = p[k].strip() if isinstance(p[k], str) else p[k]
  return out


# ---------- gpx PII strip + validation ----------

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

  Handler.conn = conn
  Handler.cfg = cfg
  Handler.login_limiter = RateLimiter(RATE_LIMIT_MAX_FAILS, RATE_LIMIT_WINDOW)
  Handler.write_lock = threading.Lock()
  Handler.last_request = time.monotonic()

  # Setup token: if enabled and no users exist yet, generate one and require it
  # on /api/register. Print to stderr only; the operator copies it from logs.
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
    conn.close()
  return 0


if __name__ == "__main__":
  sys.exit(main())
