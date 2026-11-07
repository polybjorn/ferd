"""CatalogMixin: the shipped catalog and the admin catalog endpoints."""

from __future__ import annotations

from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ..common import ValidationError, load_json_file, with_file_lock, write_json_file
from ..db import log_event
from ..places import validate_place
from ..users import catalog_baseline_hidden, catalog_baseline_open, catalog_baseline_set_hidden


class CatalogMixin:
  def _h_catalog_get(self):
    """Site-level catalog of curated places.

    Two sources are merged at read time:
      - Shipped baseline: `<static_dir>/catalog.json`, tracked in the repo and
        community-contributable via PRs. Included unless admin has flipped the
        `catalog_baseline` setting to 'closed'.
      - Local additions: `<data_dir>/catalog.local.json`, gitignored,
        admin-managed via the catalog admin endpoints.

    Local entries override shipped ones with the same name (so admins can edit
    a shipped entry by re-adding it locally). Each returned entry carries a
    `_source` field of "shipped" or "local" so the UI can label them and gate
    the Remove action."""
    user = self._require_user()
    if user is None:
      return
    # `?include_hidden=1` is an admin-only flag for the Manage catalog UI -
    # it returns hidden shipped entries with `_hidden: true` so admins can see
    # what they've suppressed and toggle it back. Anyone else gets a clean
    # filtered list.
    qs = parse_qs(urlparse(self.path).query)
    include_hidden = qs.get("include_hidden", ["0"])[0] in ("1", "true")
    if include_hidden and not user["is_admin"]:
      include_hidden = False

    data_dir = Path(self.cfg["data_dir"]).resolve()
    static_dir = Path(self.cfg["static_dir"]).resolve()
    local_path = data_dir / "catalog.local.json"
    shipped_path = static_dir / "catalog.json"

    try:
      local = load_json_file(local_path, expected_type=list, required=False, label="catalog.local.json")
    except ValidationError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))

    shipped = []
    if catalog_baseline_open(self.conn):
      try:
        shipped = load_json_file(shipped_path, expected_type=list, required=False, label="catalog.json") or []
      except ValidationError as e:
        return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))

    hidden = catalog_baseline_hidden(self.conn)

    # Build the merged list. Local entries win by name; we walk locals first so
    # the order is "local additions, then shipped" minus any shadowed shipped.
    seen: set = set()
    merged: list = []
    for entry in (local or []):
      if not isinstance(entry, dict):
        continue
      name = entry.get("name")
      if not isinstance(name, str):
        continue
      tagged = dict(entry)
      tagged["_source"] = "local"
      merged.append(tagged)
      seen.add(name)
    for entry in shipped:
      if not isinstance(entry, dict):
        continue
      name = entry.get("name")
      if not isinstance(name, str) or name in seen:
        continue
      is_hidden = name in hidden
      if is_hidden and not include_hidden:
        continue
      tagged = dict(entry)
      tagged["_source"] = "shipped"
      if is_hidden:
        tagged["_hidden"] = True
      merged.append(tagged)
      seen.add(name)
    self._send_json(HTTPStatus.OK, merged)

  def _h_admin_catalog_add(self):
    ctx = self._admin_body()
    if ctx is None:
      return
    admin, body = ctx
    entries = body.get("entries")
    if not isinstance(entries, list) or not entries:
      return self._error(HTTPStatus.BAD_REQUEST, "entries: non-empty list required")
    cleaned = []
    for i, raw in enumerate(entries):
      try:
        p = validate_place(raw)
      except ValidationError as e:
        return self._error(HTTPStatus.BAD_REQUEST, f"entry #{i}: {e}")
      # Catalog entries describe a place, not a personal visit; drop visit-only fields.
      for k in ("visited", "date_visited", "rating"):
        p.pop(k, None)
      cleaned.append(p)

    catalog_path = Path(self.cfg["data_dir"]).resolve() / "catalog.local.json"
    lock_path = catalog_path.parent / ".catalog.lock"
    state = {"added": 0, "skipped": 0, "total": 0}

    def primary_source(e):
      s = e.get("sources") if isinstance(e, dict) else None
      return s[0] if isinstance(s, list) and s and isinstance(s[0], str) else None

    def do_add():
      existing = load_json_file(catalog_path, expected_type=list, required=False, label="catalog.local.json")
      names = {e["name"] for e in existing if isinstance(e, dict) and isinstance(e.get("name"), str)}
      # Dedup by primary source URL as well as name, matching how imports are
      # linked client-side: two entries sharing a source are the same place
      # even under different display names.
      sources = {primary_source(e) for e in existing}
      sources.discard(None)
      for e in cleaned:
        psrc = primary_source(e)
        if e["name"] in names or (psrc is not None and psrc in sources):
          state["skipped"] += 1
          continue
        existing.append(e)
        names.add(e["name"])
        if psrc is not None:
          sources.add(psrc)
        state["added"] += 1
      write_json_file(catalog_path, existing)
      state["total"] = len(existing)

    try:
      with_file_lock(lock_path, do_add)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write catalog.local.json: {e}")

    log_event(self.conn, actor=admin["username"], action="admin.catalog_add",
              details={"added": state["added"], "skipped": state["skipped"]})
    self._send_json(HTTPStatus.OK, {"ok": True, **state})

  def _h_admin_catalog_delete(self):
    ctx = self._admin_body()
    if ctx is None:
      return
    admin, body = ctx
    names_in = body.get("names")
    if not isinstance(names_in, list) or not names_in or not all(isinstance(n, str) for n in names_in):
      return self._error(HTTPStatus.BAD_REQUEST, "names: non-empty list of strings required")
    drop = set(names_in)

    catalog_path = Path(self.cfg["data_dir"]).resolve() / "catalog.local.json"
    lock_path = catalog_path.parent / ".catalog.lock"
    state = {"removed": 0, "total": 0}

    def do_delete():
      existing = load_json_file(catalog_path, expected_type=list, required=False, label="catalog.local.json")
      kept = [e for e in existing if not (isinstance(e, dict) and e.get("name") in drop)]
      state["removed"] = len(existing) - len(kept)
      write_json_file(catalog_path, kept)
      state["total"] = len(kept)

    try:
      with_file_lock(lock_path, do_delete)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write catalog.local.json: {e}")

    log_event(self.conn, actor=admin["username"], action="admin.catalog_delete",
              details={"removed": state["removed"]})
    self._send_json(HTTPStatus.OK, {"ok": True, **state})

  def _h_admin_catalog_clear(self):
    admin = self._require_admin()
    if admin is None:
      return
    catalog_path = Path(self.cfg["data_dir"]).resolve() / "catalog.local.json"
    lock_path = catalog_path.parent / ".catalog.lock"
    state = {"removed": 0}

    def do_clear():
      existing = load_json_file(catalog_path, expected_type=list, required=False, label="catalog.local.json")
      state["removed"] = len(existing)
      write_json_file(catalog_path, [])

    try:
      with_file_lock(lock_path, do_clear)
    except OSError as e:
      return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"failed to write catalog.local.json: {e}")

    log_event(self.conn, actor=admin["username"], action="admin.catalog_clear",
              details={"removed": state["removed"]})
    self._send_json(HTTPStatus.OK, {"ok": True, "removed": state["removed"], "total": 0})

  def _h_admin_catalog_hide(self):
    """Toggle visibility of a single shipped catalog entry. Hidden names are
    suppressed from /api/catalog responses for everyone; admin Manage UI sees
    them via `?include_hidden=1`. Body: `{name: str, hidden: bool}`."""
    ctx = self._admin_body()
    if ctx is None:
      return
    admin, body = ctx
    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
      return self._error(HTTPStatus.BAD_REQUEST, "name required")
    if "hidden" not in body or not isinstance(body["hidden"], bool):
      return self._error(HTTPStatus.BAD_REQUEST, "hidden (bool) required")
    name = name.strip()
    with self.write_lock:
      hidden = catalog_baseline_hidden(self.conn)
      if body["hidden"]:
        hidden.add(name)
      else:
        hidden.discard(name)
      catalog_baseline_set_hidden(self.conn, hidden)
    log_event(self.conn, actor=admin["username"], action="admin.catalog_hide",
              target=name, details={"hidden": body["hidden"]})
    self._send_json(HTTPStatus.OK, {"ok": True, "name": name, "hidden": body["hidden"]})
