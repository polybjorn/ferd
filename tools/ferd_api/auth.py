"""Password hashing, sessions, API tokens and the login rate limiter."""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
import sys
import threading
import time
from hashlib import pbkdf2_hmac


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

# Non-GET paths a read-only API token may still call. Empty by design: all
# reads are GET today. If a read ever needs POST (e.g. a body-carrying search),
# add it here, otherwise read-only tokens get 403 on it (fail closed).
READONLY_POST_ALLOW: frozenset[str] = frozenset()

TOKEN_SCOPES = ("full", "readonly")

# Precomputed dummy hash used to equalize timing when a username doesn't exist.
_DUMMY_SALT = b"\x00" * SALT_BYTES

_DUMMY_HASH = pbkdf2_hmac("sha256", b"unused", _DUMMY_SALT, PBKDF2_ITERATIONS, dklen=PBKDF2_DKLEN)


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


def hash_token(raw: str) -> str:
  """sha256 hex of a bearer/session token. Tokens are stored hashed so a DB
  read can't be replayed as a live credential; the plaintext lives only in the
  client's cookie/header and is shown once at mint time."""
  return hashlib.sha256((raw or "").encode("utf-8")).hexdigest()


def session_create(conn: sqlite3.Connection, user_id: int, ip: str | None = None, user_agent: str | None = None) -> str:
  token = secrets.token_urlsafe(SESSION_BYTES)
  now = int(time.time())
  # Expired rows are inert (lookup checks expires_at) but nothing else deletes
  # them; sweep here so the table holds live sessions, not history.
  conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
  conn.execute(
    "INSERT INTO sessions(token, user_id, created_at, expires_at, last_seen_at, ip, user_agent) "
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
    (hash_token(token), user_id, now, now + SESSION_DAYS * 86400, now, ip, (user_agent or "")[:300]),
  )
  return token


def session_lookup(conn: sqlite3.Connection, token: str) -> sqlite3.Row | None:
  if not token:
    return None
  th = hash_token(token)
  row = conn.execute(
    "SELECT u.id AS id, u.username AS username, u.is_admin AS is_admin, "
    "s.expires_at AS expires_at "
    "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=?",
    (th,),
  ).fetchone()
  if row and row["expires_at"] > int(time.time()):
    return row
  if row:
    conn.execute("DELETE FROM sessions WHERE token=?", (th,))
  return None


def session_touch(conn: sqlite3.Connection, token: str) -> None:
  conn.execute("UPDATE sessions SET last_seen_at=? WHERE token=?", (int(time.time()), hash_token(token)))


def session_delete(conn: sqlite3.Connection, token: str) -> None:
  conn.execute("DELETE FROM sessions WHERE token=?", (hash_token(token),))


def session_delete_hash(conn: sqlite3.Connection, token_hash: str) -> None:
  conn.execute("DELETE FROM sessions WHERE token=?", (token_hash,))


def api_token_lookup(conn: sqlite3.Connection, raw: str) -> sqlite3.Row | None:
  """Resolve a bearer token to its owning user (+ scope). Returns None if the
  token is unknown or expired; touches last_used_at on success. A token acts
  as the user who minted it (inherits is_admin); the readonly scope is enforced
  separately at the mutating-method gate."""
  if not raw:
    return None
  th = hash_token(raw)
  row = conn.execute(
    "SELECT u.id AS id, u.username AS username, u.is_admin AS is_admin, "
    "t.scope AS scope, t.expires_at AS expires_at "
    "FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash=?",
    (th,),
  ).fetchone()
  if not row:
    return None
  if row["expires_at"] is not None and row["expires_at"] <= int(time.time()):
    conn.execute("DELETE FROM api_tokens WHERE token_hash=?", (th,))
    return None
  conn.execute("UPDATE api_tokens SET last_used_at=? WHERE token_hash=?", (int(time.time()), th))
  return row


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


def _valid_username(name: str) -> bool:
  if not name or len(name) > USERNAME_MAX:
    return False
  return name.replace("_", "").replace("-", "").isalnum()


def _valid_password(pw: str) -> bool:
  return PASSWORD_MIN <= len(pw) <= PASSWORD_MAX


def new_setup_token() -> str:
  token = secrets.token_urlsafe(24)
  print(f"[api] setup token (required for first registration): {token}", file=sys.stderr)
  print("[api] use the 'Setup token' field on the registration page", file=sys.stderr)
  return token
