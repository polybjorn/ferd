"""RequestMixin: request plumbing, auth resolution, JSON/cookie/CORS helpers."""

from __future__ import annotations

import http.cookies
import json
import sqlite3
import sys
import time
from http import HTTPStatus
from pathlib import Path
from urllib.parse import urlparse

from .. import crawl
from ..auth import READONLY_POST_ALLOW, SESSION_DAYS, api_token_lookup, hash_token, session_lookup, session_touch
from ..db import BUSY_TIMEOUT_SECONDS
from ..common import BodyTooLarge, NotFoundError, ValidationError
from ..store import transaction
from ..users import ensure_user_dir


class RequestMixin:
  def handle_one_request(self):
    type(self).last_request = time.monotonic()
    self._req_conn = None
    self._user_resolved = False
    self._user_cache = None
    self._auth_scope = None
    # Hash of the session token that authenticated this request (cookie or
    # bearer-as-session), or None when auth came from an API token / anon.
    # Used so logout, "current session" marking, and password-change session
    # pruning work identically for cookie and bearer logins.
    self._auth_session_hash = None
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
      c = sqlite3.connect(self.cfg["db_path"], isolation_level=None, timeout=BUSY_TIMEOUT_SECONDS)
      c.execute("PRAGMA foreign_keys=ON")
      c.row_factory = sqlite3.Row
      self._req_conn = c
    return self._req_conn

  def log_message(self, fmt, *args):
    sys.stderr.write(f"[api] {self.address_string()} {fmt % args}\n")

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
    morsel = jar.get("session")
    return morsel.value if morsel else ""

  def _bearer_token(self) -> str:
    h = self.headers.get("Authorization") or ""
    return h[7:].strip() if h.startswith("Bearer ") else ""

  def _current_user(self) -> sqlite3.Row | None:
    """Resolve the request's user, cookie session first, then bearer API token.
    Cached per request so the read-only gate and the handler share one lookup.
    Sets self._auth_scope to 'full' or 'readonly'."""
    if self._user_resolved:
      return self._user_cache
    user, scope = self._resolve_auth()
    self._user_cache = user
    self._auth_scope = scope
    self._user_resolved = True
    return user

  def _resolve_auth(self) -> tuple[sqlite3.Row | None, str | None]:
    token = self._cookie_token()
    user = session_lookup(self.conn, token)
    if user:
      # last_seen_at is best-effort; failures are non-fatal.
      try:
        session_touch(self.conn, token)
      except sqlite3.Error:
        pass
      self._auth_session_hash = hash_token(token)
      return user, "full"
    raw = self._bearer_token()
    if raw:
      # A bearer token can be a login session (cross-origin/native clients
      # that can't use cookies) or a long-lived API token (scripts). Try the
      # session table first so a mobile login behaves exactly like a cookie
      # session: full scope, listed in Active sessions, revocable there.
      suser = session_lookup(self.conn, raw)
      if suser:
        try:
          session_touch(self.conn, raw)
        except sqlite3.Error:
          pass
        self._auth_session_hash = hash_token(raw)
        return suser, "full"
      row = api_token_lookup(self.conn, raw)
      if row:
        return row, row["scope"]
    return None, None

  def _block_if_readonly(self) -> bool:
    """Send 403 and return True if this mutating request is authed by a
    read-only token. Every mutation is non-GET, so calling this at the top of
    do_POST/do_PUT/do_DELETE covers all writes from one place. Fails closed: a
    future read that uses POST must be added to READONLY_POST_ALLOW or it will
    be rejected for read-only tokens (the set is empty today)."""
    self._current_user()
    if self._auth_scope == "readonly" and urlparse(self.path).path not in READONLY_POST_ALLOW:
      self._error(HTTPStatus.FORBIDDEN, "read-only token")
      return True
    return False

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

  def _store_write(self, fn):
    """Run fn() as one all-or-nothing transaction, mapping storage errors to
    HTTP responses (NotFoundError -> 404, ValidationError -> 409, database
    error -> 500). Returns (True, result), or (False, None) after an error
    response has been sent."""
    try:
      with transaction(self.conn):
        return True, fn()
    except NotFoundError as e:
      self._error(HTTPStatus.NOT_FOUND, str(e))
    except ValidationError as e:
      self._error(HTTPStatus.CONFLICT, str(e))
    except sqlite3.Error as e:
      self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to save: {e}")
    return False, None

  def _client_ip(self) -> str:
    peer = self.client_address[0] if self.client_address else "?"
    if peer not in type(self).trusted_proxies:
      return peer
    headers = getattr(self, "headers", None)
    if headers is None:
      return peer
    real_ip = (headers.get("X-Real-IP") or "").strip()
    if real_ip:
      return real_ip
    forwarded = (headers.get("X-Forwarded-For") or "").strip()
    if forwarded:
      # The rightmost entry was appended by the trusted proxy itself;
      # everything left of it arrived in the client's request and can be
      # forged.
      return forwarded.split(",")[-1].strip() or peer
    return peer

  def _origin(self) -> str | None:
    """The origin this request reached, for absolute URLs in pages and in
    robots.txt. The scheme comes from X-Forwarded-Proto when a trusted proxy
    sent it, else from secure_cookies, which says the site is served over
    HTTPS. None when the Host header is missing or malformed."""
    headers = getattr(self, "headers", None)
    if headers is None:
      return None
    scheme = "https" if self.cfg.get("secure_cookies") else "http"
    peer = self.client_address[0] if self.client_address else "?"
    if peer in type(self).trusted_proxies:
      proto = (headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
      if proto in ("http", "https"):
        scheme = proto
    return crawl.origin(scheme, headers.get("Host"))

  def address_string(self) -> str:
    # Feeds the access-log line; same resolution as the rate limiter and
    # audit trail so the log shows the client, not the proxy.
    return self._client_ip()

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

  def _admin_body(self):
    """(admin row, parsed body) for an admin-only JSON endpoint, or None once
    the error response has been sent."""
    admin = self._require_admin()
    if admin is None:
      return None
    body = self._read_body_or_400()
    if body is None:
      return None
    return admin, body

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
    parts = [f"session={token}", "Path=/", "HttpOnly", "SameSite=Lax"]
    if self.cfg.get("secure_cookies", True):
      parts.append("Secure")
    if max_age is not None:
      parts.append(f"Max-Age={max_age}")
    return ("Set-Cookie", "; ".join(parts))

  def _login_response_headers(self, token: str, body: dict, payload: dict) -> list[tuple[str, str]]:
    """Decide how a fresh session token is handed back on login/register.

    Default (browser): set an HttpOnly session cookie so JS can never read the
    token (XSS defense). When the client opts in with `{"token": true}` it gets
    the token in the JSON body instead and no cookie is set; cross-origin /
    native clients that can't use cookies present it as `Authorization: Bearer`.
    Exposing the token in the body is gated on this explicit opt-in precisely so
    the cookie path keeps its HttpOnly guarantee."""
    if body.get("token"):
      payload["session_token"] = token
      payload["token_type"] = "Bearer"
      return []
    return [self._set_session_cookie(token, SESSION_DAYS * 86400)]

  def _cors_origin(self) -> str | None:
    """Resolve the Access-Control-Allow-Origin value for this request, or None
    to omit CORS. "*" (the default) is safe here because cross-origin clients
    authenticate with bearer tokens and no cookies, so the origin carries no
    ambient authority; we never emit Access-Control-Allow-Credentials."""
    allowed = self.cfg.get("cors_origins", "*")
    if isinstance(allowed, str):
      allowed = [allowed] if allowed else []
    if not allowed:
      return None
    if "*" in allowed:
      return "*"
    origin = self.headers.get("Origin")
    if not origin:
      return None
    # Return the matched allowlist entry (a trusted config value), not the raw
    # request header, so no user-controlled data is reflected into the response.
    for allowed_origin in allowed:
      if allowed_origin == origin:
        return allowed_origin
    return None

  def end_headers(self):
    origin = self._cors_origin()
    if origin:
      self.send_header("Access-Control-Allow-Origin", origin)
      if origin != "*":
        self.send_header("Vary", "Origin")
    super().end_headers()

  def do_OPTIONS(self):
    # CORS preflight. end_headers() injects Access-Control-Allow-Origin.
    self.send_response(HTTPStatus.NO_CONTENT)
    if self._cors_origin():
      self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
      self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
      self.send_header("Access-Control-Max-Age", "86400")
    self.send_header("Content-Length", "0")
    self.end_headers()

  def _send_plain(self, status: int, body: bytes):
    self.send_response(status)
    self.send_header("Content-Type", "text/plain; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)
