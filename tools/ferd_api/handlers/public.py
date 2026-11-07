"""PublicMixin: read-only endpoints for published maps."""

from __future__ import annotations

from http import HTTPStatus
from pathlib import Path

from ..common import ValidationError, safe_path_component
from ..users import user_dir, user_published


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

  def _public_user_dir(self, username: str) -> Path | None:
    """Return the user dir iff that user exists and has publish=ON. Else None
    (caller should 404). Username is sanitized as a path component too."""
    try:
      safe_path_component(username)
    except ValidationError:
      return None
    if not user_published(self.conn, username):
      return None
    try:
      return user_dir(self.cfg, username)
    except ValidationError:
      return None

  def _h_public_places(self, username: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._send_user_json(udir, "places.json", list)

  def _h_public_areas(self, username: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._send_user_json(udir, "areas.json", list)

  def _h_public_routes(self, username: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._send_user_json(udir, "routes.json", dict, default={"regions": []})

  def _h_public_metadata(self, username: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._send_user_json(udir, "metadata.json", dict, default={})

  def _h_public_category_labels(self, username: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._send_user_json(udir, "category-labels.json", dict, default={}, key="category_labels")

  def _h_public_geojson(self, username: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._send_geojson(udir, username)

  def _h_public_gpx(self, username: str, region: str, fname: str):
    udir = self._public_user_dir(username)
    if udir is None:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    self._serve_gpx(udir, region, fname)
