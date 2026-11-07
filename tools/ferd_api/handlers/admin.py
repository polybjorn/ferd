"""AdminMixin: admin settings, user management, stats and the audit log."""

from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import time
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ..common import ValidationError
from ..db import log_event, setting_set
from ..users import admin_count, count_user_places, count_user_routes, dir_size_bytes, set_user_published, user_count, user_dir


class AdminMixin:
  def _h_settings_registration(self):
    ctx = self._admin_body()
    if ctx is None:
      return
    admin, body = ctx
    mode = body.get("mode")
    if mode not in ("open", "closed"):
      return self._error(HTTPStatus.BAD_REQUEST, "mode must be 'open' or 'closed'")
    with self.write_lock:
      setting_set(self.conn, "registration", mode)
    log_event(self.conn, actor=admin["username"], action="admin.registration_gate",
              details={"mode": mode})
    self._send_json(HTTPStatus.OK, {"registration": mode})

  def _h_admin_settings_publishing(self):
    ctx = self._admin_body()
    if ctx is None:
      return
    admin, body = ctx
    mode = body.get("mode")
    if mode not in ("open", "closed"):
      return self._error(HTTPStatus.BAD_REQUEST, "mode must be 'open' or 'closed'")
    with self.write_lock:
      setting_set(self.conn, "publishing", mode)
    log_event(self.conn, actor=admin["username"], action="admin.publishing_gate",
              details={"mode": mode})
    self._send_json(HTTPStatus.OK, {"publishing": mode})

  def _h_admin_settings_catalog_baseline(self):
    ctx = self._admin_body()
    if ctx is None:
      return
    admin, body = ctx
    mode = body.get("mode")
    if mode not in ("open", "closed"):
      return self._error(HTTPStatus.BAD_REQUEST, "mode must be 'open' or 'closed'")
    with self.write_lock:
      setting_set(self.conn, "catalog_baseline", mode)
    log_event(self.conn, actor=admin["username"], action="admin.catalog_baseline",
              details={"mode": mode})
    self._send_json(HTTPStatus.OK, {"catalog_baseline": mode})

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
      "routes": count_user_routes(udir),
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
    routes_total = 0
    if users_root.exists():
      for child in users_root.iterdir():
        if not child.is_dir():
          continue
        places_total += count_user_places(child)
        routes_total += count_user_routes(child)
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
      "routes": routes_total,
      "db_bytes": db_bytes,
      "data_bytes": data_bytes,
    })

  def _h_admin_logs(self):
    if self._require_admin() is None:
      return
    qs = parse_qs(urlparse(self.path).query)
    try:
      limit = int((qs.get("limit") or ["200"])[0])
    except ValueError:
      return self._error(HTTPStatus.BAD_REQUEST, "limit must be an integer")
    limit = max(1, min(limit, 1000))
    before_id_raw = (qs.get("before_id") or [""])[0]
    if before_id_raw:
      try:
        before_id = int(before_id_raw)
      except ValueError:
        return self._error(HTTPStatus.BAD_REQUEST, "before_id must be an integer")
      rows = self.conn.execute(
        "SELECT id, ts, actor, action, target, details FROM audit_log "
        "WHERE id < ? ORDER BY id DESC LIMIT ?", (before_id, limit + 1),
      ).fetchall()
    else:
      rows = self.conn.execute(
        "SELECT id, ts, actor, action, target, details FROM audit_log "
        "ORDER BY id DESC LIMIT ?", (limit + 1,),
      ).fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    out = []
    for r in rows:
      details = None
      if r["details"]:
        try:
          details = json.loads(r["details"])
        except json.JSONDecodeError:
          details = {"_raw": r["details"]}
      out.append({
        "id": r["id"],
        "ts": r["ts"],
        "actor": r["actor"],
        "action": r["action"],
        "target": r["target"],
        "details": details,
      })
    next_before_id = rows[-1]["id"] if has_more and rows else None
    self._send_json(HTTPStatus.OK, {"logs": out, "next_before_id": next_before_id})

  def _h_admin_logs_clear(self):
    admin = self._require_admin()
    if admin is None:
      return
    with self.write_lock:
      self.conn.execute("DELETE FROM audit_log")
      # Record the wipe itself inside the lock so a racing log_event from
      # another handler can't sneak a row in between DELETE and INSERT.
      log_event(self.conn, actor=admin["username"], action="admin.logs_clear")
    self._send_json(HTTPStatus.OK, {"ok": True})

  def _h_admin_user_role(self, uid: int):
    ctx = self._admin_body()
    if ctx is None:
      return
    admin, body = ctx
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
    log_event(self.conn, actor=admin["username"], action="admin.user_role_change",
              target=target["username"], details={"is_admin": val})
    self._send_json(HTTPStatus.OK, {"ok": True, "is_admin": val})

  def _h_admin_user_unpublish(self, uid: int):
    admin = self._require_admin()
    if admin is None:
      return
    target = self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not target:
      return self._error(HTTPStatus.NOT_FOUND, "user not found")
    with self.write_lock:
      set_user_published(self.conn, uid, False)
    log_event(self.conn, actor=admin["username"], action="admin.user_force_unpublish",
              target=target["username"])
    self._send_json(HTTPStatus.OK, {"ok": True})

  def _h_admin_unpublish_all(self):
    admin = self._require_admin()
    if admin is None:
      return
    with self.write_lock:
      cur = self.conn.execute("UPDATE users SET published=0 WHERE published=1")
      affected = cur.rowcount
    log_event(self.conn, actor=admin["username"], action="admin.unpublish_all",
              details={"affected": affected})
    self._send_json(HTTPStatus.OK, {"ok": True, "affected": affected})

  def _h_admin_user_revoke_sessions(self, uid: int):
    admin = self._require_admin()
    if admin is None:
      return
    target = self.conn.execute("SELECT id, username FROM users WHERE id=?", (uid,)).fetchone()
    if not target:
      return self._error(HTTPStatus.NOT_FOUND, "user not found")
    with self.write_lock:
      cur = self.conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
      removed = cur.rowcount
    log_event(self.conn, actor=admin["username"], action="admin.user_revoke_sessions",
              target=target["username"], details={"removed": removed})
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
          print(f"[api] delete user {uname}: rmtree errors: {errors}", file=sys.stderr)
        elif udir.exists():
          cleanup_warning = "data dir still present after rmtree"
          print(f"[api] delete user {uname}: data dir still present", file=sys.stderr)
    except (OSError, ValidationError) as e:
      cleanup_warning = f"data dir cleanup failed: {e}"
      print(f"[api] delete user {uname}: {e}", file=sys.stderr)
    log_event(self.conn, actor=admin["username"], action="admin.user_delete",
              target=uname, details={"cleanup_warning": cleanup_warning} if cleanup_warning else None)
    payload = {"ok": True}
    if cleanup_warning:
      payload["cleanup_warning"] = cleanup_warning
    self._send_json(HTTPStatus.OK, payload)
