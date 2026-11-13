"""StaticMixin: static-file serving."""

from __future__ import annotations

import sys
from http import HTTPStatus
from pathlib import Path
from urllib.parse import unquote

from .. import crawl, csp
from ..common import BodyTooLarge, ValidationError, resolve_under
from ..static import APP_VERSION_PLACEHOLDER, STATIC_MIME, SW_VERSION_PLACEHOLDER, get_app_version, get_sw_version


class StaticMixin:
  def _serve_static(self, path: str):
    static_dir = self.cfg.get("static_dir")
    if not static_dir:
      return self._error(HTTPStatus.NOT_FOUND, "not found")
    base = Path(static_dir)
    # The canonical link names the page asked for, before the rewrites below.
    page_path = path
    if path in ("", "/"):
      path = "/index.html"
    # Public per-user URLs (`/u/<username>/...`) all serve the SPA shell; the
    # frontend reads the path and fetches the right /api/u/<username>/... data.
    if path.startswith("/u/"):
      path = "/index.html"
    # URL-decode percent-escapes (e.g. spaces, accented chars).
    rel = unquote(path.lstrip("/"))
    # Lexical traversal check: refuse any ".." segment or NUL byte. We don't
    # resolve symlinks for the check, so configured symlinks (gpx/, etc.) work.
    if "\x00" in rel:
      return self._send_plain(HTTPStatus.BAD_REQUEST, b"bad path")
    parts = rel.split("/")
    if any(p == ".." or p == "" for p in parts[:-1]) or ".." in parts:
      return self._send_plain(HTTPStatus.FORBIDDEN, b"forbidden")
    # Deny server-side asset directories regardless of OS path resolution.
    # tools/ holds the API code + DB + server config; deploy/ holds unit files.
    # Neither should be reachable through the static handler.
    if parts[0] in ("tools", "deploy", ".git"):
      return self._send_plain(HTTPStatus.FORBIDDEN, b"forbidden")
    # Resolved containment check: in addition to the lexical traversal guard
    # above, verify the final resolved path stays under `base`. Catches symlink
    # escapes the lexical check can't see.
    try:
      target = resolve_under(base, rel)
    except ValidationError:
      return self._send_plain(HTTPStatus.FORBIDDEN, b"forbidden")
    if not target.exists() or not target.is_file():
      return self._send_plain(HTTPStatus.NOT_FOUND, b"not found")
    suffix = target.suffix.lower()
    ctype = STATIC_MIME.get(suffix, "application/octet-stream")
    try:
      data = target.read_bytes()
    except OSError:
      return self._send_plain(HTTPStatus.INTERNAL_SERVER_ERROR, b"read failed")
    # Substitute the CACHE_VERSION placeholder in sw.js with a hash of all
    # shell assets so installed PWAs auto-update when anything they cache
    # changes, without anyone editing sw.js by hand.
    if rel == "sw.js" and SW_VERSION_PLACEHOLDER.encode() in data:
      version = get_sw_version(base)
      data = data.replace(SW_VERSION_PLACEHOLDER.encode(),
                          version.encode())
    elif rel == "index.html":
      data = data.replace(APP_VERSION_PLACEHOLDER.encode(),
                          get_app_version().encode())
      # The stylesheet links carry it: nginx serves them with no cache
      # header, so a browser can keep an old file under a new page.
      data = data.replace(SW_VERSION_PLACEHOLDER.encode(),
                          get_sw_version(base).encode())
      data = data.replace(crawl.SHARE_TAGS_PLACEHOLDER.encode(),
                          crawl.share_tags(self._origin(), page_path).encode())
      data = crawl.page_title(data.decode("utf-8"), page_path).encode("utf-8")
    self.send_response(HTTPStatus.OK)
    self.send_header("Content-Type", ctype)
    self.send_header("Content-Length", str(len(data)))
    self.send_header("Cache-Control", "no-cache")
    self.send_header("X-Content-Type-Options", "nosniff")
    # The policy acts on the document and on the service worker script; every
    # other response would carry it for nothing.
    # The hash comes from the file on disk, not the page above: that holds a
    # name from the URL, and the import map has nothing that varies by request.
    if rel in ("index.html", "sw.js"):
      for k, v in csp.headers(csp.importmap_hash_for(base / "index.html")):
        self.send_header(k, v)
    self.end_headers()
    if self.command != "HEAD":
      self.wfile.write(data)

  def _h_csp_report(self):
    """Log a CSP violation report as one line. Nothing is stored and nothing
    is checked but size and rate, since a browser sends these unauthenticated."""
    ip = self._client_ip()
    if self.csp_limiter.is_blocked(ip):
      return self._send_plain(HTTPStatus.TOO_MANY_REQUESTS, b"too many reports")
    self.csp_limiter.record_failure(ip)
    try:
      raw = self._read_raw(csp.REPORT_MAX_BYTES)
    except BodyTooLarge:
      return self._send_plain(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, b"too large")
    except ValueError:
      return self._send_plain(HTTPStatus.BAD_REQUEST, b"bad report")
    ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    try:
      reports = csp.parse_reports(raw, ctype)
    except ValueError:
      return self._send_plain(HTTPStatus.BAD_REQUEST, b"bad report")
    for r in reports:
      sys.stderr.write(f"[api] csp-violation {ip} directive={r['directive']} "
                       f"blocked={r['blocked']} source={r['source']}:{r['line']}\n")
    self.send_response(HTTPStatus.NO_CONTENT)
    self.send_header("Content-Length", "0")
    self.end_headers()
