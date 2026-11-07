"""SyncMixin: change feed and batched writes for a local-first client."""

from __future__ import annotations

from http import HTTPStatus
from urllib.parse import parse_qs, urlparse

from .. import store
from ..areas import validate_area
from ..common import ValidationError, safe_path_component
from ..labels import clean_category_labels
from ..places import PLACE_ID_RE, validate_place
from ..routes import validate_route_metadata


SYNC_DEFAULT_LIMIT = 500

SYNC_MAX_LIMIT = 5000

SYNC_MAX_BATCH = 500

SYNC_ID_MAX = 256

SYNC_MAX_REV = 2**63 - 1

PREFS_MAX_BYTES = 1024 * 1024  # what a PUT /api/me/prefs body may hold

LABELS_MAX = 200  # clean_category_labels' cap per map, enforced over the whole set here


def _clean_metadata_key(key: str) -> str:
  key = key.strip()
  parts = key.split("/")
  if len(parts) not in (1, 2):
    raise ValidationError("metadata id must be 'Region/Route name' or 'Route name'")
  for p in parts:
    safe_path_component(p)
  return key


def _prepare_put(kind: str, item_id: str, data):
  """The value to store for a client put, validated the way the matching REST
  endpoint validates it. Returns None for a metadata entry that validates to
  nothing, which the caller treats as a delete."""
  if kind in ("place", "area"):
    if not PLACE_ID_RE.match(item_id):
      raise ValidationError("id must be an 8-char hex string")
    if not isinstance(data, dict):
      raise ValidationError("data must be an object")
    return (validate_place if kind == "place" else validate_area)(dict(data, id=item_id))
  if kind == "metadata":
    entry = validate_route_metadata(data if data is not None else {})
    return entry or None
  if kind == "label":
    cleaned = clean_category_labels({item_id: data})
    if item_id.strip() not in cleaned:
      raise ValidationError("label must have a non-empty display text")
    return cleaned[item_id.strip()]
  return data


def _check_id(kind: str, item_id) -> str:
  if not isinstance(item_id, str) or not item_id or len(item_id) > SYNC_ID_MAX:
    raise ValidationError("id must be a non-empty string")
  if kind == "label" and item_id != item_id.strip():
    raise ValidationError("label id must not have surrounding whitespace")
  return item_id


class SyncMixin:
  def _h_sync_changes(self):
    user = self._require_user()
    if user is None:
      return
    qs = parse_qs(urlparse(self.path).query)
    try:
      since = int((qs.get("since") or ["0"])[0])
      limit = int((qs.get("limit") or [str(SYNC_DEFAULT_LIMIT)])[0])
    except ValueError:
      return self._error(HTTPStatus.BAD_REQUEST, "since and limit must be integers")
    if not 0 <= since <= SYNC_MAX_REV or limit < 1:
      return self._error(HTTPStatus.BAD_REQUEST, f"since must be 0 to {SYNC_MAX_REV} and limit >= 1")
    limit = min(limit, SYNC_MAX_LIMIT)
    epoch = (qs.get("epoch") or [None])[0]
    self._send_json(HTTPStatus.OK, store.changes_since(self.conn, user["id"], since, limit, epoch))

  def _h_sync_batch(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    changes = body.get("changes") if isinstance(body, dict) else None
    if not isinstance(changes, list):
      return self._error(HTTPStatus.BAD_REQUEST, "changes (list) required")
    if len(changes) > SYNC_MAX_BATCH:
      return self._error(HTTPStatus.BAD_REQUEST, f"too many changes (max {SYNC_MAX_BATCH})")

    # Validate everything before the first write, so a bad item at index 400
    # does not leave 399 applied.
    ops = []
    for i, change in enumerate(changes):
      try:
        if not isinstance(change, dict):
          raise ValidationError("change must be an object")
        kind, op = change.get("kind"), change.get("op")
        if kind == "route":
          raise ValidationError("routes are server-owned; change GPX files through /api/gpx")
        if kind not in store.CLIENT_KINDS:
          raise ValidationError(f"kind must be one of {', '.join(store.CLIENT_KINDS)}")
        item_id = _check_id(kind, change.get("id"))
        if kind == "metadata":
          item_id = _clean_metadata_key(item_id)
        if op == "put":
          value = _prepare_put(kind, item_id, change.get("data"))
          op = "put" if value is not None else "delete"
        elif op == "delete":
          if kind in ("place", "area") and not PLACE_ID_RE.match(item_id):
            raise ValidationError("id must be an 8-char hex string")
          value = None
        else:
          raise ValidationError("op must be 'put' or 'delete'")
      except ValidationError as e:
        return self._error(HTTPStatus.BAD_REQUEST, f"changes[{i}]: {e}")
      ops.append((kind, item_id, op, value))

    def apply():
      results = []
      for kind, item_id, op, value in ops:
        if op == "put":
          rev, changed = store.put_item(self.conn, user["id"], kind, item_id, value)
        else:
          rev = store.delete_item(self.conn, user["id"], kind, item_id)
          changed = rev is not None
          if rev is None:
            rev = store.item_rev(self.conn, user["id"], kind, item_id)
        results.append({"kind": kind, "id": item_id, "rev": rev, "status": "applied" if changed else "noop"})
      # The whole-set limits REST enforces per request; checked after the batch
      # so an over-limit batch rolls back as one.
      if store.count_items(self.conn, user["id"], "label") > LABELS_MAX:
        raise ValidationError(f"too many category labels (max {LABELS_MAX})")
      if store.items_bytes(self.conn, user["id"], "pref") > PREFS_MAX_BYTES:
        raise ValidationError(f"prefs too large (max {PREFS_MAX_BYTES} bytes)")
      return results, store.head_rev(self.conn, user["id"])

    ok, out = self._store_write(apply)
    if not ok:
      return
    results, head = out
    self._send_json(HTTPStatus.OK, {"ok": True, "rev": head, "epoch": store.get_epoch(self.conn, user["id"]), "results": results})
