"""PublicMixin: read-only endpoints for published maps."""

from __future__ import annotations

from http import HTTPStatus

from .. import store
from ..common import ValidationError, safe_path_component
from ..users import user_dir


class PublicMixin:
  def _h_public_maps(self):
    """Public list of usernames whose map is currently published.
    Used by the logged-out landing page; no auth required."""
    rows = self.conn.execute(
      "SELECT username FROM users WHERE published=1 ORDER BY username"
    ).fetchall()
    self._send_json(HTTPStatus.OK, {
      "usernames": [r["username"] for r in rows],
    })

  def _public_user(self, username: str):
    """(user id, user dir) iff that user exists and has publish=ON. Else None
    (caller should 404). Username is sanitized as a path component too."""
    try:
      safe_path_component(username)
    except ValidationError:
      return None
    row = self.conn.execute("SELECT id, username, published FROM users WHERE username=?", (username,)).fetchone()
    if not row or not row["published"]:
      return None
    # The URL's spelling may differ in case from the stored name (the column is
    # NOCASE); the folder is named after the stored one.
    username = row["username"]
    try:
      udir = user_dir(self.cfg, username)
    except ValidationError:
      return None
    return row["id"], udir

  def _public_rows(self, username: str, read):
    """Send read(user id) as JSON for a published user; 404 otherwise."""
    found = self._public_user(username)
    if found is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._send_json(HTTPStatus.OK, read(found[0]))

  def _h_public_places(self, username: str):
    self._public_rows(username, lambda uid: store.list_items(self.conn, uid, "place"))

  def _h_public_areas(self, username: str):
    self._public_rows(username, lambda uid: store.list_items(self.conn, uid, "area"))

  def _h_public_routes(self, username: str):
    self._public_rows(username, lambda uid: store.routes_manifest(self.conn, uid))

  def _h_public_metadata(self, username: str):
    self._public_rows(username, lambda uid: store.get_map(self.conn, uid, "metadata"))

  def _h_public_category_labels(self, username: str):
    self._public_rows(username, lambda uid: {"category_labels": store.get_map(self.conn, uid, "label")})

  def _h_public_geojson(self, username: str):
    found = self._public_user(username)
    if found is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._send_geojson(found[1], found[0], username)

  def _h_public_gpx(self, username: str, region: str, fname: str):
    found = self._public_user(username)
    if found is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._serve_gpx(found[1], region, fname)
