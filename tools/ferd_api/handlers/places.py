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
