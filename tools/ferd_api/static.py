"""Static-file MIME types and the content-derived service-worker/app versions."""

from __future__ import annotations

import hashlib
import re
import time
from pathlib import Path


# sw.js source carries this placeholder; the static handler swaps it for a
# content-derived version on every serve so we never bump CACHE_VERSION by
# hand. Hash covers sw.js itself + every file listed in its SHELL_ASSETS,
# so any shell change (frontend, vendor, manifest) yields a new version.
SW_VERSION_PLACEHOLDER = "__FERD_CACHE_VERSION__"

# Substituted into index.html on serve so the frontend knows its own version
# without /api/state (e.g. in local-only mode); see get_app_version below.
APP_VERSION_PLACEHOLDER = "__FERD_APP_VERSION__"

_SW_VERSION_CACHE: dict = {"version": None, "computed_at": 0.0}

_SW_VERSION_TTL_SEC = 5

_APP_VERSION_CACHE: dict = {"version": None, "computed_at": 0.0}


def _read_app_version() -> str:
  """Read the human-readable app version from the VERSION file at the repo
  root. Falls back to 'unknown' if the file is missing (older deployments,
  bare source layouts)."""
  for candidate in (Path(__file__).resolve().parent.parent.parent / "VERSION",
                    Path(__file__).resolve().parent.parent / "VERSION"):
    try:
      return candidate.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
      continue
  return "unknown"


def get_app_version() -> str:
  """Re-read VERSION with a short TTL (like get_sw_version) instead of caching
  it for the whole process lifetime, so a `git pull` that bumps VERSION is
  reflected without restarting the API."""
  import time
  now = time.monotonic()
  if (_APP_VERSION_CACHE["version"] is None
      or now - _APP_VERSION_CACHE["computed_at"] > _SW_VERSION_TTL_SEC):
    _APP_VERSION_CACHE["version"] = _read_app_version()
    _APP_VERSION_CACHE["computed_at"] = now
  return _APP_VERSION_CACHE["version"]


def _compute_sw_version(static_dir: Path) -> str:
  sw_path = static_dir / "sw.js"
  try:
    sw_text = sw_path.read_text(encoding="utf-8")
  except OSError:
    return "ferd-unknown"
  h = hashlib.sha256()
  h.update(sw_text.encode("utf-8"))
  m = re.search(r"const\s+SHELL_ASSETS\s*=\s*\[(.*?)\];", sw_text, re.DOTALL)
  if m:
    for rel in re.findall(r"'([^']+)'", m.group(1)):
      rel = rel.strip()
      if not rel or rel == "/":
        continue
      f = static_dir / rel.lstrip("/")
      if f.is_file():
        try:
          h.update(f.read_bytes())
        except OSError:
          pass
  return "ferd-" + h.hexdigest()[:10]


def get_sw_version(static_dir: Path) -> str:
  import time
  now = time.monotonic()
  if (_SW_VERSION_CACHE["version"] is None
      or now - _SW_VERSION_CACHE["computed_at"] > _SW_VERSION_TTL_SEC):
    _SW_VERSION_CACHE["version"] = _compute_sw_version(static_dir)
    _SW_VERSION_CACHE["computed_at"] = now
  return _SW_VERSION_CACHE["version"]


STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".gpx": "application/gpx+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json",
}
