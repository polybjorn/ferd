"""SessionMixin: state, register/login/logout, password change, sessions and API tokens."""

from __future__ import annotations

import secrets
import time
from http import HTTPStatus

from ..auth import PASSWORD_MAX, PASSWORD_MIN, SESSION_BYTES, TOKEN_SCOPES, _valid_password, _valid_username, dummy_verify, hash_password, hash_token, new_setup_token, session_create, session_delete_hash, verify_password
from ..db import log_event
from ..static import get_app_version
from ..users import catalog_baseline_open, create_user, ensure_user_dir, find_user, publishing_open, registration_open, user_count, user_published


class SessionMixin:
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
      "catalog_baseline_open": catalog_baseline_open(self.conn),
      "has_users": user_count(self.conn) > 0,
      "requires_setup_token": bool(self.cfg.get("require_setup_token")) and user_count(self.conn) == 0,
      "version": get_app_version(),
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
      # The boot-time token is missing when the instance started with users or
      # the table emptied since (a wipe, an empty restore), so mint one here
      # rather than let the gate fall open.
      if first_user and self.cfg.get("require_setup_token"):
        if type(self).setup_token is None:
          type(self).setup_token = new_setup_token()
        if not supplied_token or not secrets.compare_digest(supplied_token, type(self).setup_token):
          return self._error(HTTPStatus.FORBIDDEN, "setup token required or incorrect")
      user_id = create_user(self.conn, username, password, is_admin=first_user)
      token = session_create(self.conn, user_id, ip=self._client_ip(), user_agent=self.headers.get("User-Agent"))
      if first_user:
        type(self).setup_token = None  # Token no longer relevant.
    log_event(self.conn, actor=username, action="auth.register",
              details={"first_user": first_user, "ip": self._client_ip()})
    ensure_user_dir(self.cfg, username)
    payload = {"username": username, "is_admin": first_user}
    headers = self._login_response_headers(token, body, payload)
    self._send_json(HTTPStatus.CREATED, payload, headers)

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
      log_event(self.conn, actor=None, action="auth.login_failure",
                target=username, details={"ip": ip, "reason": "no_such_user"})
      return self._error(HTTPStatus.UNAUTHORIZED, "invalid credentials")
    if not verify_password(password, user["pw_salt"], user["pw_hash"]):
      self.login_limiter.record_failure(ip)
      log_event(self.conn, actor=None, action="auth.login_failure",
                target=user["username"], details={"ip": ip, "reason": "bad_password"})
      return self._error(HTTPStatus.UNAUTHORIZED, "invalid credentials")
    self.login_limiter.clear(ip)
    token = session_create(self.conn, user["id"], ip=ip, user_agent=self.headers.get("User-Agent"))
    log_event(self.conn, actor=user["username"], action="auth.login_success",
              details={"ip": ip})
    payload = {"username": user["username"], "is_admin": bool(user["is_admin"])}
    headers = self._login_response_headers(token, body, payload)
    self._send_json(HTTPStatus.OK, payload, headers)

  def _h_logout(self):
    # Resolve auth so a bearer-session logout deletes the right row.
    self._current_user()
    if self._auth_session_hash:
      session_delete_hash(self.conn, self._auth_session_hash)
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
    current_hash = self._auth_session_hash or ""
    with self.write_lock:
      self.conn.execute("UPDATE users SET pw_salt=?, pw_hash=? WHERE id=?", (salt, digest, user["id"]))
      # Invalidate every other session for this user; keep the current one.
      self.conn.execute(
        "DELETE FROM sessions WHERE user_id=? AND token!=?",
        (user["id"], current_hash),
      )
    self._send_json(HTTPStatus.OK, {"ok": True})

  def _h_sessions_list(self):
    user = self._current_user()
    if not user:
      return self._error(HTTPStatus.UNAUTHORIZED, "not authenticated")
    current_hash = self._auth_session_hash
    rows = self.conn.execute(
      "SELECT token, created_at, expires_at, last_seen_at, ip, user_agent "
      "FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC, created_at DESC",
      (user["id"],),
    ).fetchall()
    out = []
    for r in rows:
      out.append({
        "id": r["token"][:12],  # short opaque handle, enough for the revoke call
        "current": r["token"] == current_hash,
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
    current_hash = hash_token(self._cookie_token())
    with self.write_lock:
      # Match by token-prefix, scoped to this user, never the current session.
      self.conn.execute(
        "DELETE FROM sessions WHERE user_id=? AND substr(token, 1, 12)=? AND token!=?",
        (user["id"], target, current_hash),
      )
    self._send_json(HTTPStatus.OK, {"ok": True})

  def _h_sessions_revoke_others(self):
    user = self._current_user()
    if not user:
      return self._error(HTTPStatus.UNAUTHORIZED, "not authenticated")
    current_hash = hash_token(self._cookie_token())
    with self.write_lock:
      cur = self.conn.execute(
        "DELETE FROM sessions WHERE user_id=? AND token!=?",
        (user["id"], current_hash),
      )
      removed = cur.rowcount
    self._send_json(HTTPStatus.OK, {"ok": True, "removed": removed})

  def _h_tokens_list(self):
    user = self._require_user()
    if user is None:
      return
    rows = self.conn.execute(
      "SELECT token_hash, name, scope, created_at, last_used_at, expires_at "
      "FROM api_tokens WHERE user_id=? ORDER BY created_at DESC",
      (user["id"],),
    ).fetchall()
    out = [{
      "id": r["token_hash"][:12],  # short opaque handle for the revoke call
      "name": r["name"],
      "scope": r["scope"],
      "created_at": r["created_at"],
      "last_used_at": r["last_used_at"],
      "expires_at": r["expires_at"],
    } for r in rows]
    self._send_json(HTTPStatus.OK, {"tokens": out})

  def _h_tokens_create(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    name = (body.get("name") or "").strip()
    if not name or len(name) > 100:
      return self._error(HTTPStatus.BAD_REQUEST, "name required (1-100 chars)")
    scope = (body.get("scope") or "full").strip()
    if scope not in TOKEN_SCOPES:
      return self._error(HTTPStatus.BAD_REQUEST, "scope must be full or readonly")
    expires_at = None
    days = body.get("expires_in_days")
    if days is not None:
      if not isinstance(days, int) or isinstance(days, bool) or not (1 <= days <= 3650):
        return self._error(HTTPStatus.BAD_REQUEST, "expires_in_days must be 1-3650")
      expires_at = int(time.time()) + days * 86400
    raw = secrets.token_urlsafe(SESSION_BYTES)
    now = int(time.time())
    with self.write_lock:
      self.conn.execute(
        "INSERT INTO api_tokens(token_hash, user_id, name, scope, created_at, last_used_at, expires_at) "
        "VALUES (?, ?, ?, ?, ?, NULL, ?)",
        (hash_token(raw), user["id"], name, scope, now, expires_at),
      )
    log_event(self.conn, actor=user["username"], action="token.create",
              details={"name": name, "scope": scope})
    # Plaintext is returned once here and never stored; the row holds only its hash.
    self._send_json(HTTPStatus.OK, {"token": raw, "name": name, "scope": scope, "expires_at": expires_at})

  def _h_tokens_revoke(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    target = (body.get("id") or "").strip()
    if not target or len(target) != 12:
      return self._error(HTTPStatus.BAD_REQUEST, "id required (12-char prefix from /api/me/tokens)")
    with self.write_lock:
      cur = self.conn.execute(
        "DELETE FROM api_tokens WHERE user_id=? AND substr(token_hash, 1, 12)=?",
        (user["id"], target),
      )
      removed = cur.rowcount
    if removed:
      log_event(self.conn, actor=user["username"], action="token.revoke", details={"id": target})
    self._send_json(HTTPStatus.OK, {"ok": True, "removed": removed})
