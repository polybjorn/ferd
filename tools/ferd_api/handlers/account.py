"""AccountMixin: preferences, publish toggle, export and import."""

from __future__ import annotations

import io
import json
import sys
import zipfile
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ..common import BodyTooLarge, ImportTooLarge, ValidationError, with_file_lock, write_json_file
from ..db import log_event
from ..gpx import build_geojson
from ..transfer import IMPORT_MAX_BYTES, IMPORT_WRITERS, parse_payloads, stage_archive
from ..users import _is_export_junk, _walk_follow_symlinks, publishing_open, set_user_published


class AccountMixin:
  def _h_prefs_get(self):
    user = self._require_user()
    if user is None:
      return
    udir = self._user_dir(user["username"])
    self._send_user_json(udir, "prefs.json", dict, default={})

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
    ok, _ = self._locked_write(user, "prefs.json", lambda: write_json_file(udir / "prefs.json", body))
    if not ok:
      return
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
    log_event(self.conn, actor=user["username"], action="user.publish_toggle",
              details={"published": val})
    self._send_json(HTTPStatus.OK, {"ok": True, "published": val})

  def _h_export_get(self):
    user = self._require_user()
    if user is None:
      return
    udir = self._user_dir(user["username"])
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
      # Follow symlinks so a symlinked gpx/ dir (the documented dev pattern)
      # is included. Path.rglob silently skips into symlinked directories.
      for root, files in _walk_follow_symlinks(udir):
        root_p = Path(root)
        for fname in sorted(files):
          if fname.startswith("."):
            continue  # locks (dotfiles), OS noise (.DS_Store, etc.)
          if _is_export_junk(fname):
            continue  # editor/maintenance backups, OS metadata (see import)
          path = root_p / fname
          try:
            zf.write(path, arcname=str(path.relative_to(udir)))
          except OSError as e:
            # A single unreadable file (e.g. a stray root-owned backup) must not
            # abort the whole export: the response is buffered, so an exception
            # here would close the connection with no reply at all.
            print(f"[api] export: skipping unreadable {path}: {e}", file=sys.stderr)
    payload = buf.getvalue()
    fname = f"ferd-{user['username']}-export.zip"
    self.send_response(HTTPStatus.OK)
    self.send_header("Content-Type", "application/zip")
    self.send_header("Content-Length", str(len(payload)))
    self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    self.wfile.write(payload)

  def _send_geojson(self, udir: Path, username: str) -> None:
    try:
      body = json.dumps(build_geojson(udir), ensure_ascii=False).encode("utf-8")
    except ValidationError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
    self.send_response(HTTPStatus.OK)
    self.send_header("Content-Type", "application/geo+json")
    self.send_header("Content-Length", str(len(body)))
    # Headers are latin-1, and a username may be any Unicode letter.
    fname = f"ferd-{username}.geojson" if username.isascii() else "ferd.geojson"
    self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    self.wfile.write(body)

  def _h_export_geojson_get(self):
    user = self._require_user()
    if user is None:
      return
    self._send_geojson(self._user_dir(user["username"]), user["username"])

  def _h_import_post(self):
    user = self._require_user()
    if user is None:
      return

    qs = parse_qs(urlparse(self.path).query)
    mode = (qs.get("mode") or ["replace"])[0]
    if mode not in IMPORT_WRITERS:
      return self._error(HTTPStatus.BAD_REQUEST, "mode must be 'replace', 'merge', or 'prefs'")

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
      payload = parse_payloads(stage_archive(raw), mode)
    except ImportTooLarge as e:
      return self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, str(e))
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    udir = self._user_dir(user["username"])
    try:
      result = with_file_lock(udir / ".import.lock", lambda: IMPORT_WRITERS[mode](udir, payload))
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"import failed: {e}")

    log_event(self.conn, actor=user["username"], action="user.import", details={
      "mode": mode,
      "places": result["added_places"],
      "areas": result["added_areas"],
      "gpx": len(payload.gpx),
      "metadata": result["changed_meta"],
      "prefs": result["changed_prefs"],
    })
    manifest = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {
      "ok": True,
      "mode": mode,
      "imported": {
        "places": result["added_places"],
        "areas": result["added_areas"],
        "gpx": len(payload.gpx),
        "metadata": result["changed_meta"],
        "prefs": result["changed_prefs"],
      },
      "manifest": manifest,
    })
