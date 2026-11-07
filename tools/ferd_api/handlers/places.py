"""PlacesMixin: category labels, places and areas."""

from __future__ import annotations

from http import HTTPStatus

from .. import store
from ..areas import validate_area
from ..common import NotFoundError, ValidationError
from ..labels import clean_category_labels
from ..places import PLACE_ID_RE, validate_place


class PlacesMixin:
  def _h_me_category_labels_get(self):
    user = self._require_user()
    if user is None:
      return
    self._send_json(HTTPStatus.OK, {"category_labels": store.get_map(self.conn, user["id"], "label")})

  def _h_me_category_labels_put(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    try:
      cleaned = clean_category_labels(body.get("category_labels"))
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    merged: dict[str, dict] = {}

    def do_update():
      # Preserve previously-assigned colors when the caller (e.g. Manage
      # Categories, which only knows about labels) omits color for a slug
      # that already had one. Keeps auto-assigned colors stable across edits.
      existing = store.get_map(self.conn, user["id"], "label")
      for slug, entry in cleaned.items():
        prior = existing.get(slug)
        if "color" not in entry and isinstance(prior, dict) and "color" in prior:
          entry = dict(entry)
          entry["color"] = prior["color"]
        merged[slug] = entry
      store.replace_map(self.conn, user["id"], "label", merged)

    ok, _ = self._store_write(do_update)
    if not ok:
      return
    self._send_json(HTTPStatus.OK, {"ok": True, "category_labels": merged})

  def _create_item(self, kind: str, validate, status_key: str, total_key: str):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    # Ignore any client-supplied id; the server assigns one. Strip before
    # validation so we don't accidentally honor a colliding hex string.
    if isinstance(body, dict):
      body.pop("id", None)
    try:
      item = validate(body)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    def do_append():
      item["id"] = store.new_id(self.conn, user["id"], kind)
      store.put_item(self.conn, user["id"], kind, item["id"], item)
      return store.count_items(self.conn, user["id"], kind)

    ok, total = self._store_write(do_append)
    if not ok:
      return
    self._send_json(HTTPStatus.CREATED, {"ok": True, total_key: total, status_key: item})

  def _delete_item(self, kind: str, total_key: str):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    target_id = (body.get("id") or "").strip()
    if not target_id or not PLACE_ID_RE.match(target_id):
      return self._error(HTTPStatus.BAD_REQUEST, "id required (8-char hex)")

    def do_delete():
      if store.delete_item(self.conn, user["id"], kind, target_id) is None:
        raise NotFoundError(f"{kind} not found: {target_id}")
      return store.count_items(self.conn, user["id"], kind)

    ok, total = self._store_write(do_delete)
    if not ok:
      return
    self._send_json(HTTPStatus.OK, {"ok": True, total_key: total})

  def _h_places_create(self):
    self._create_item("place", validate_place, "place", "total_places")

  def _h_places_update(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    target_id = (body.get("id") or "").strip()
    if not target_id or not PLACE_ID_RE.match(target_id):
      return self._error(HTTPStatus.BAD_REQUEST, "id required (8-char hex)")
    place_payload = body.get("place")
    if not isinstance(place_payload, dict):
      return self._error(HTTPStatus.BAD_REQUEST, "place required")
    # The payload's id (if any) is overwritten with the target id so the row
    # keeps its identity through the rename.
    place_payload = dict(place_payload)
    place_payload["id"] = target_id
    focus_in_payload = "image_focus" in place_payload
    try:
      validated = validate_place(place_payload)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    def do_update():
      current = store.get_item(self.conn, user["id"], "place", target_id)
      if current is None:
        raise NotFoundError(f"place not found: {target_id}")
      # Drop stale image_focus when image changes and the caller didn't
      # explicitly set a new focus. Focus is tied to a specific image's
      # framing; an image swap invalidates the old anchor.
      if not focus_in_payload and current.get("image") != validated.get("image"):
        validated.pop("image_focus", None)
      store.put_item(self.conn, user["id"], "place", target_id, validated)

    ok, _ = self._store_write(do_update)
    if not ok:
      return
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

    def do_clear():
      cleared = 0
      for kind in ("place", "area"):
        for item in store.list_items(self.conn, user["id"], kind):
          if isinstance(item, dict) and item.get("category") == target:
            item.pop("category", None)
            store.put_item(self.conn, user["id"], kind, item["id"], item)
            cleared += 1
      return cleared

    ok, cleared = self._store_write(do_clear)
    if not ok:
      return
    self._send_json(HTTPStatus.OK, {"ok": True, "cleared": cleared})

  def _h_places_delete(self):
    self._delete_item("place", "total_places")

  def _h_areas_create(self):
    self._create_item("area", validate_area, "area", "total_areas")

  def _h_areas_update(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    target_id = (body.get("id") or "").strip()
    if not target_id or not PLACE_ID_RE.match(target_id):
      return self._error(HTTPStatus.BAD_REQUEST, "id required (8-char hex)")
    area_payload = body.get("area")
    if not isinstance(area_payload, dict):
      return self._error(HTTPStatus.BAD_REQUEST, "area required")
    try:
      validated = validate_area(dict(area_payload, id=target_id))
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    def do_update():
      if store.get_item(self.conn, user["id"], "area", target_id) is None:
        raise NotFoundError(f"area not found: {target_id}")
      store.put_item(self.conn, user["id"], "area", target_id, validated)

    ok, _ = self._store_write(do_update)
    if not ok:
      return
    self._send_json(HTTPStatus.OK, {"ok": True, "area": validated})

  def _h_areas_delete(self):
    self._delete_item("area", "total_areas")

  def _h_places_get(self):
    user = self._require_user()
    if user is None:
      return
    self._send_json(HTTPStatus.OK, store.list_items(self.conn, user["id"], "place"))

  def _h_areas_get(self):
    user = self._require_user()
    if user is None:
      return
    self._send_json(HTTPStatus.OK, store.list_items(self.conn, user["id"], "area"))
