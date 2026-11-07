"""PlacesMixin: category labels, places and areas."""

from __future__ import annotations

import secrets
from http import HTTPStatus

from ..areas import validate_area
from ..common import ValidationError, find_place_idx, load_json_file, write_json_file
from ..labels import clean_category_labels
from ..places import PLACE_ID_RE, validate_place


class PlacesMixin:
  def _h_me_category_labels_get(self):
    user = self._require_user()
    if user is None:
      return
    udir = self._user_dir(user["username"])
    self._send_user_json(udir, "category-labels.json", dict, default={}, key="category_labels")

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

    labels_path = self._user_dir(user["username"]) / "category-labels.json"
    merged: dict[str, dict] = {}

    def do_update():
      # Preserve previously-assigned colors when the caller (e.g. Manage
      # Categories, which only knows about labels) omits color for a slug
      # that already had one. Keeps auto-assigned colors stable across edits.
      existing = load_json_file(labels_path, expected_type=dict, required=False, label="category-labels.json")
      for slug, entry in cleaned.items():
        prior = existing.get(slug) if isinstance(existing, dict) else None
        if "color" not in entry and isinstance(prior, dict) and "color" in prior:
          entry = dict(entry)
          entry["color"] = prior["color"]
        merged[slug] = entry
      write_json_file(labels_path, merged)

    ok, _ = self._locked_write(user, "category-labels.json", do_update)
    if not ok:
      return
    self._send_json(HTTPStatus.OK, {"ok": True, "category_labels": merged})

  def _h_places_create(self):
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
      place = validate_place(body)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    places_path = self._user_dir(user["username"]) / "places.json"

    def do_append():
      existing = load_json_file(places_path, expected_type=list, required=False, label="places.json")
      seen = {p["id"] for p in existing if isinstance(p, dict) and isinstance(p.get("id"), str)}
      new_id = secrets.token_hex(4)
      while new_id in seen:
        new_id = secrets.token_hex(4)
      place["id"] = new_id
      existing.append(place)
      write_json_file(places_path, existing)
      return len(existing)

    ok, total = self._locked_write(user, "places.json", do_append)
    if not ok:
      return
    self._send_json(HTTPStatus.CREATED, {"ok": True, "total_places": total, "place": place})

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

    places_path = self._user_dir(user["username"]) / "places.json"

    def do_update():
      existing = load_json_file(places_path, expected_type=list, required=True, label="places.json")
      idx = find_place_idx(existing, target_id)
      # Drop stale image_focus when image changes and the caller didn't
      # explicitly set a new focus. Focus is tied to a specific image's
      # framing; an image swap invalidates the old anchor.
      if not focus_in_payload and existing[idx].get("image") != validated.get("image"):
        validated.pop("image_focus", None)
      existing[idx] = validated
      write_json_file(places_path, existing)

    ok, _ = self._locked_write(user, "places.json", do_update)
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

    udir = self._user_dir(user["username"])

    def clear_in(filename: str):
      path = udir / filename

      def do_clear():
        existing = load_json_file(path, expected_type=list, required=False, label=filename)
        cleared = 0
        for p in existing:
          if isinstance(p, dict) and p.get("category") == target:
            p.pop("category", None)
            cleared += 1
        if cleared:
          write_json_file(path, existing)
        return cleared

      return self._locked_write(user, filename, do_clear)

    ok, cleared = clear_in("places.json")
    if not ok:
      return
    ok, cleared_areas = clear_in("areas.json")
    if not ok:
      return
    self._send_json(HTTPStatus.OK, {"ok": True, "cleared": cleared + cleared_areas})

  def _h_places_delete(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    target_id = (body.get("id") or "").strip()
    if not target_id or not PLACE_ID_RE.match(target_id):
      return self._error(HTTPStatus.BAD_REQUEST, "id required (8-char hex)")

    places_path = self._user_dir(user["username"]) / "places.json"

    def do_delete():
      existing = load_json_file(places_path, expected_type=list, required=True, label="places.json")
      idx = find_place_idx(existing, target_id)
      del existing[idx]
      write_json_file(places_path, existing)
      return len(existing)

    ok, total = self._locked_write(user, "places.json", do_delete)
    if not ok:
      return
    self._send_json(HTTPStatus.OK, {"ok": True, "total_places": total})

  def _h_areas_create(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    if isinstance(body, dict):
      body.pop("id", None)
    try:
      area = validate_area(body)
    except ValidationError as e:
      return self._error(HTTPStatus.BAD_REQUEST, str(e))

    areas_path = self._user_dir(user["username"]) / "areas.json"

    def do_append():
      existing = load_json_file(areas_path, expected_type=list, required=False, label="areas.json")
      seen = {a["id"] for a in existing if isinstance(a, dict) and isinstance(a.get("id"), str)}
      new_id = secrets.token_hex(4)
      while new_id in seen:
        new_id = secrets.token_hex(4)
      area["id"] = new_id
      existing.append(area)
      write_json_file(areas_path, existing)
      return len(existing)

    ok, total = self._locked_write(user, "areas.json", do_append)
    if not ok:
      return
    self._send_json(HTTPStatus.CREATED, {"ok": True, "total_areas": total, "area": area})

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

    areas_path = self._user_dir(user["username"]) / "areas.json"

    def do_update():
      existing = load_json_file(areas_path, expected_type=list, required=False, label="areas.json")
      existing[find_place_idx(existing, target_id, "area")] = validated
      write_json_file(areas_path, existing)

    ok, _ = self._locked_write(user, "areas.json", do_update)
    if not ok:
      return
    self._send_json(HTTPStatus.OK, {"ok": True, "area": validated})

  def _h_areas_delete(self):
    user = self._require_user()
    if user is None:
      return
    body = self._read_body_or_400()
    if body is None:
      return
    target_id = (body.get("id") or "").strip()
    if not target_id or not PLACE_ID_RE.match(target_id):
      return self._error(HTTPStatus.BAD_REQUEST, "id required (8-char hex)")

    areas_path = self._user_dir(user["username"]) / "areas.json"

    def do_delete():
      existing = load_json_file(areas_path, expected_type=list, required=False, label="areas.json")
      del existing[find_place_idx(existing, target_id, "area")]
      write_json_file(areas_path, existing)
      return len(existing)

    ok, total = self._locked_write(user, "areas.json", do_delete)
    if not ok:
      return
    self._send_json(HTTPStatus.OK, {"ok": True, "total_areas": total})

  def _h_places_get(self):
    user = self._require_user()
    if user is None:
      return
    udir = self._user_dir(user["username"])
    self._send_user_json(udir, "places.json", list)

  def _h_areas_get(self):
    user = self._require_user()
    if user is None:
      return
    self._send_user_json(self._user_dir(user["username"]), "areas.json", list)
