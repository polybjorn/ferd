"""PlacesMixin: category labels, places and areas."""

from __future__ import annotations

from http import HTTPStatus

from .. import store


class PlacesMixin:
  def _h_me_category_labels_get(self):
    user = self._require_user()
    if user is None:
      return
    self._send_json(HTTPStatus.OK, {"category_labels": store.get_map(self.conn, user["id"], "label")})

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
