"""The HTTP handler: routing tables and dispatch over the per-concern mixins."""

from __future__ import annotations

import http.server
import threading
from http import HTTPStatus
from urllib.parse import unquote, urlparse

from . import csp
from .auth import RateLimiter
from .static import get_app_version
from .handlers.request import RequestMixin
from .handlers.static import StaticMixin
from .handlers.session import SessionMixin
from .handlers.admin import AdminMixin
from .handlers.catalog import CatalogMixin
from .handlers.places import PlacesMixin
from .handlers.routes import RoutesMixin
from .handlers.account import AccountMixin
from .handlers.public import PublicMixin
from .handlers.sync import SyncMixin


class Handler(RequestMixin, StaticMixin, SessionMixin, AdminMixin, CatalogMixin, PlacesMixin,
              RoutesMixin, AccountMixin, PublicMixin, SyncMixin, http.server.BaseHTTPRequestHandler):
  cfg: dict = None
  login_limiter: RateLimiter = None
  # Counts every CSP report, not only failures: the sink takes no auth.
  csp_limiter: RateLimiter = RateLimiter(csp.REPORT_RATE_MAX, csp.REPORT_RATE_WINDOW)
  # Serializes register-and-create_user (and similar read-then-write critical
  # sections) across worker threads. Each request opens its own SQLite
  # connection, so this lock is for application-level invariants, not
  # connection safety.
  write_lock: threading.Lock = None
  # Monotonic timestamp of the most recent request; consumed by the idle watcher.
  last_request: float = 0.0
  # Set at startup, or at a registration attempt, while `require_setup_token`
  # is enabled and no users exist. Cleared once the first user registers.
  setup_token: str | None = None
  # Parsed from cfg["trusted_proxies"] at startup.
  trusted_proxies: frozenset[str] = frozenset()

  # Exact paths per method, as handler names; the query string is not part of
  # the path. Paths that carry parameters go through PREFIX_ROUTES, whose
  # routers parse the remainder and send their own 404.
  ROUTES = {
    "GET": {
      "/api/health": "_h_health",
      "/api/state": "_h_state",
      "/api/sessions": "_h_sessions_list",
      "/api/places": "_h_places_get",
      "/api/areas": "_h_areas_get",
      "/api/routes": "_h_routes_get",
      "/api/metadata": "_h_metadata_get",
      "/api/me/prefs": "_h_prefs_get",
      "/api/me/category-labels": "_h_me_category_labels_get",
      "/api/me/export": "_h_export_get",
      "/api/me/export.geojson": "_h_export_geojson_get",
      "/api/me/tokens": "_h_tokens_list",
      "/api/sync/changes": "_h_sync_changes",
      "/api/public-maps": "_h_public_maps",
      "/api/catalog": "_h_catalog_get",
      "/api/admin/users": "_h_admin_users_list",
      "/api/admin/stats": "_h_admin_stats",
      "/api/admin/logs": "_h_admin_logs",
    },
    "POST": {
      "/api/register": "_h_register",
      "/api/csp-report": "_h_csp_report",
      "/api/login": "_h_login",
      "/api/logout": "_h_logout",
      "/api/change-password": "_h_change_password",
      "/api/settings/registration": "_h_settings_registration",
      "/api/gpx": "_h_gpx_upload",
      "/api/gpx/move": "_h_gpx_move",
      "/api/gpx/set-completed": "_h_gpx_set_completed",
      "/api/regions/rename": "_h_region_rename",
      "/api/regions/delete": "_h_region_delete",
      "/api/regions/clear": "_h_region_clear",
      "/api/me/publish": "_h_publish_post",
      "/api/me/import": "_h_import_post",
      "/api/sync/batch": "_h_sync_batch",
      "/api/me/tokens": "_h_tokens_create",
      "/api/me/tokens/revoke": "_h_tokens_revoke",
      "/api/sessions/revoke": "_h_sessions_revoke",
      "/api/sessions/revoke-others": "_h_sessions_revoke_others",
      "/api/admin/settings/publishing": "_h_admin_settings_publishing",
      "/api/admin/settings/catalog-baseline": "_h_admin_settings_catalog_baseline",
      "/api/admin/unpublish-all": "_h_admin_unpublish_all",
      "/api/admin/catalog/add": "_h_admin_catalog_add",
      "/api/admin/catalog/delete": "_h_admin_catalog_delete",
      "/api/admin/catalog/clear": "_h_admin_catalog_clear",
      "/api/admin/catalog/hide": "_h_admin_catalog_hide",
    },
    "PUT": {},
    "DELETE": {
      "/api/gpx": "_h_gpx_delete",
      "/api/admin/logs": "_h_admin_logs_clear",
    },
  }
  PREFIX_ROUTES = {
    "GET": (("/api/gpx/", "_route_gpx_get"), ("/api/u/", "_route_public_get")),
    "POST": (("/api/admin/users/", "_route_admin_user_post"),),
    "PUT": (),
    "DELETE": (("/api/admin/users/", "_route_admin_user_delete"),),
  }
  PUBLIC_ROUTES = {
    "places": "_h_public_places",
    "areas": "_h_public_areas",
    "routes": "_h_public_routes",
    "metadata": "_h_public_metadata",
    "category-labels": "_h_public_category_labels",
    "export.geojson": "_h_public_geojson",
  }
  ADMIN_USER_POST_ROUTES = {
    "role": "_h_admin_user_role",
    "unpublish": "_h_admin_user_unpublish",
    "revoke-sessions": "_h_admin_user_revoke_sessions",
  }

  def _dispatch(self, method: str, path: str) -> bool:
    """Run the handler routed for `path`. False when no route matches."""
    name = self.ROUTES[method].get(path)
    if name:
      getattr(self, name)()
      return True
    for prefix, router in self.PREFIX_ROUTES[method]:
      if path.startswith(prefix):
        getattr(self, router)(path[len(prefix):])
        return True
    return False

  def _dispatch_write(self, method: str):
    if self._block_if_readonly():
      return
    if not self._dispatch(method, urlparse(self.path).path):
      self._error(HTTPStatus.NOT_FOUND, "not found")

  def _route_gpx_get(self, rest: str):
    parts = rest.split("/", 1)
    if len(parts) == 2:
      return self._h_gpx_get(unquote(parts[0]), unquote(parts[1]))
    if parts[0]:
      return self._h_gpx_get("", unquote(parts[0]))
    self._error(HTTPStatus.NOT_FOUND, "not found")

  def _route_public_get(self, rest: str):
    seg = rest.split("/", 1)
    if len(seg) < 2:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    uname, tail = unquote(seg[0]), seg[1]
    name = self.PUBLIC_ROUTES.get(tail)
    if name:
      return getattr(self, name)(uname)
    if tail.startswith("gpx/"):
      gparts = tail[len("gpx/"):].split("/", 1)
      if len(gparts) == 2:
        return self._h_public_gpx(uname, unquote(gparts[0]), unquote(gparts[1]))
      if gparts[0]:
        return self._h_public_gpx(uname, "", unquote(gparts[0]))
    self._error(HTTPStatus.NOT_FOUND, "not found")

  def _route_admin_user_post(self, rest: str):
    parts = rest.split("/", 1)
    if len(parts) == 2 and parts[0].isdigit() and parts[1] in self.ADMIN_USER_POST_ROUTES:
      return getattr(self, self.ADMIN_USER_POST_ROUTES[parts[1]])(int(parts[0]))
    self._error(HTTPStatus.NOT_FOUND, "not found")

  def _route_admin_user_delete(self, rest: str):
    if rest.isdigit():
      return self._h_admin_user_delete(int(rest))
    self._error(HTTPStatus.NOT_FOUND, "not found")

  def do_GET(self):
    path = urlparse(self.path).path
    if self._dispatch("GET", path):
      return
    if path.startswith("/api/"):
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    return self._serve_static(path)

  def do_HEAD(self):
    # Static files only, so `curl -I` can read their headers. The API's
    # handlers write their bodies unconditionally.
    path = urlparse(self.path).path
    if path.startswith("/api/"):
      return self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
    return self._serve_static(path)

  def do_POST(self):
    self._dispatch_write("POST")

  def do_PUT(self):
    self._dispatch_write("PUT")

  def do_DELETE(self):
    self._dispatch_write("DELETE")

  def _h_health(self):
    self._send_json(HTTPStatus.OK, {"status": "ok", "version": get_app_version()})
