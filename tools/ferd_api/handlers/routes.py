"""RoutesMixin: GPX uploads and moves, regions, route metadata and GPX serving."""

from __future__ import annotations

import sqlite3
import sys
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .. import store
from ..common import BodyTooLarge, ConflictError, NotFoundError, ValidationError, atomic_write_bytes, nfc_component, nfc_route_key, resolve_under, safe_path_component, with_file_lock
from ..manifest import regenerate_manifest
from ..gpx import GPX_MAX_BYTES, apply_gpx_move, parse_gpx_move, plan_gpx_move, prune_route_metadata, strip_gpx_pii, validate_gpx


class RoutesMixin:
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

    lock_path = udir / ".gpx.lock"
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
      # Every route without a file, not only this one, so entries an older
      # version left behind go too. The files are gone either way; a failure
      # here leaves the entries for the next delete.
      if removed:
        try:
          prune_route_metadata(self.conn, user["id"], gpx_root)
        except sqlite3.Error as e:
          print(f"[api] route metadata not pruned: {e}", file=sys.stderr)

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
      region = nfc_component(raw_region) if raw_region else ""
      name = nfc_component((qs.get("name") or [""])[0])
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

    lock_path = udir / ".gpx.lock"

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

  def _h_gpx_move(self):
    """Move and/or rename a route (and any .planned.gpx sibling). Re-keys
    its metadata entry, prunes the old region dir if empty, and
    regenerates the manifest. Body: {key, new_region, new_name?}. Key is
    'Region/Route' or 'Route' (no region); new_region is '' for no-region;
    new_name is optional (defaults to the current route name)."""
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    try:
      req = parse_gpx_move(body)
      if req["noop"]:
        return self._send_json(HTTPStatus.OK, {"ok": True, "old_key": req["old_key"],
                                               "new_key": req["old_key"], "moved": 0})
      udir = self._user_dir(user["username"])
      pairs = plan_gpx_move(udir / "gpx", req)
    except NotFoundError as e:
      return self._error(HTTPStatus.NOT_FOUND, str(e))
    except ConflictError as e:
      return self._error(HTTPStatus.CONFLICT, str(e))
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    try:
      moved = with_file_lock(udir / ".gpx.lock", lambda: apply_gpx_move(self.conn, user["id"], req, pairs))
    except (OSError, sqlite3.Error) as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"move failed: {e}")
    manifest_status = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {
      "ok": True, "old_key": req["old_key"], "new_key": req["new_key"],
      "moved": moved, "manifest": manifest_status,
    })

  def _h_gpx_set_completed(self):
    """Flip a route between completed (.gpx) and planned (.planned.gpx) by
    renaming the file. Body: {key, completed}. No-op if the route is already
    in the requested state. 404 if the route doesn't exist. 409 if marking
    a completed route as planned would collide with an existing
    .planned.gpx sibling (or vice versa)."""
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    key = body.get("key") or ""
    completed = body.get("completed")
    if not isinstance(key, str) or not key:
      return self._error(HTTPStatus.BAD_REQUEST, "key required")
    if not isinstance(completed, bool):
      return self._error(HTTPStatus.BAD_REQUEST, "completed (bool) required")

    parts = key.split("/")
    if len(parts) == 1:
      region, route_name = "", parts[0]
    elif len(parts) == 2:
      region, route_name = parts
    else:
      return self._error(HTTPStatus.BAD_REQUEST, f"invalid key: {key}")
    try:
      if region:
        safe_path_component(region)
      safe_path_component(route_name)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    udir = self._user_dir(user["username"])
    gpx_root = udir / "gpx"
    try:
      parts_walked = (region, f"{route_name}.gpx") if region else (f"{route_name}.gpx",)
      parts_planned = (region, f"{route_name}.planned.gpx") if region else (f"{route_name}.planned.gpx",)
      walked = resolve_under(gpx_root, *parts_walked)
      planned = resolve_under(gpx_root, *parts_planned)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    if completed:
      if walked.is_file():
        return self._send_json(HTTPStatus.OK, {"ok": True, "completed": True, "changed": False})
      if not planned.is_file():
        return self._error(HTTPStatus.NOT_FOUND, f"route not found: {key}")
      src, dst = planned, walked
    else:
      if not walked.is_file():
        if not planned.is_file():
          return self._error(HTTPStatus.NOT_FOUND, f"route not found: {key}")
        return self._send_json(HTTPStatus.OK, {"ok": True, "completed": False, "changed": False})
      if planned.is_file():
        return self._error(HTTPStatus.CONFLICT,
                           "cannot mark as planned: a planned variant already exists for this route")
      src, dst = walked, planned

    lock_path = udir / ".gpx.lock"
    def do_set():
      src.rename(dst)
    try:
      with_file_lock(lock_path, do_set)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"set-completed failed: {e}")
    manifest_status = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {
      "ok": True, "completed": completed, "changed": True,
      "manifest": manifest_status,
    })

  def _h_region_rename(self):
    """Rename a region: rename the gpx/<from> directory and rewrite any
    metadata keys that referenced the old name. Regenerates the manifest."""
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    try:
      old_name = safe_path_component(body.get("from") or "")
      new_name = nfc_component(body.get("to") or "")
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

    lock_path = udir / ".gpx.lock"
    moved = {"routes": 0, "metadata": 0}

    def do_rename():
      src.rename(dst)
      moved["routes"] = sum(1 for p in dst.glob("*.gpx") if p.is_file())
      moved["metadata"] = store.rekey_metadata_prefix(self.conn, user["id"], old_name + "/", new_name + "/")

    try:
      with_file_lock(lock_path, do_rename)
    except (OSError, sqlite3.Error) as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"rename failed: {e}")
    manifest_status = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {
      "ok": True, "from": old_name, "to": new_name,
      "routes": moved["routes"], "metadata": moved["metadata"],
      "manifest": manifest_status,
    })

  def _h_region_clear(self):
    """Move every GPX in gpx/<name>/ up to gpx/ (no-region bucket), rewrite
    matching metadata keys, then delete the now-empty directory.
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

    lock_path = udir / ".gpx.lock"
    moved = {"routes": 0, "metadata": 0}

    def do_clear():
      for p in files:
        p.rename(gpx_root / p.name)
        # Count one per unique route base (collapse .planned siblings).
        if not p.name.endswith(".planned.gpx"):
          moved["routes"] += 1
      # Rewrite metadata keys: "<name>/Route" -> "Route"
      moved["metadata"] = store.rekey_metadata_prefix(self.conn, user["id"], name + "/", "")
      # Best-effort prune.
      try:
        if not any(region_dir.iterdir()):
          region_dir.rmdir()
      except OSError:
        pass

    try:
      with_file_lock(lock_path, do_clear)
    except (OSError, sqlite3.Error) as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"clear failed: {e}")
    manifest_status = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {
      "ok": True, "name": name,
      "routes": moved["routes"], "metadata": moved["metadata"],
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

    lock_path = udir / ".gpx.lock"

    def do_delete():
      target.rmdir()

    try:
      with_file_lock(lock_path, do_delete)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"delete failed: {e}")
    manifest_status = self._regenerate_manifest(udir)
    self._send_json(HTTPStatus.OK, {"ok": True, "name": name, "manifest": manifest_status})

  def _regenerate_manifest(self, target_dir: Path) -> dict:
    return regenerate_manifest(self.cfg, self.conn, self._current_user()["id"], target_dir)

  def _h_routes_get(self):
    user = self._require_user()
    if user is None:
      return
    self._send_json(HTTPStatus.OK, store.routes_manifest(self.conn, user["id"]))

  def _h_metadata_get(self):
    user = self._require_user()
    if user is None:
      return
    self._send_json(HTTPStatus.OK, store.get_map(self.conn, user["id"], "metadata"))

  def _h_gpx_get(self, region: str, fname: str):
    """Serve an owned GPX file. Path components are validated."""
    user = self._require_user()
    if user is None:
      return
    self._serve_gpx(self._user_dir(user["username"]), region, fname)

  def _serve_gpx(self, udir: Path, region: str, fname: str):
    try:
      region_safe = safe_path_component(region) if region else ""
      file_safe = safe_path_component(fname)
    except ValidationError:
      return self._error(HTTPStatus.BAD_REQUEST, "invalid path")
    if not file_safe.lower().endswith(".gpx"):
      return self._error(HTTPStatus.BAD_REQUEST, "expected .gpx")
    # Names are stored composed, so a decomposed URL (a client holding a
    # route list from before the merge) finds the composed file. The spelling
    # as sent is the fallback, for a route the merge left decomposed.
    target = None
    for spelling in (nfc_route_key, str):
      parts = tuple(spelling(p) for p in (region_safe, file_safe) if p)
      try:
        candidate = resolve_under(udir / "gpx", *parts)
      except ValidationError:
        return self._error(HTTPStatus.BAD_REQUEST, "invalid path")
      if candidate.is_file():
        target = candidate
        break
    if target is None:
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
