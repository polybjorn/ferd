"""Default configuration and config-file loading."""

from __future__ import annotations

import json
import os
from pathlib import Path


DEFAULT_CONFIG = {
  "bind": "127.0.0.1:8091",
  "db_path": "tools/app.db",
  "data_dir": ".",
  "manifest_cmd": None,
  "initial_user": None,
  "initial_password": None,
  "secure_cookies": True,
  "max_body_bytes": 1_048_576,  # 1 MiB for JSON endpoints
  # If set, the server also serves static files from this directory for any
  # non-/api/* GET. Intended for development; in production let nginx serve
  # static and proxy /api/* to the API.
  "static_dir": None,
  # If > 0, the process exits after this many seconds with no request activity.
  # Pair with systemd socket activation for zero-idle RAM cost.
  "idle_exit_seconds": 0,
  # If true, first-run registration also requires a setup token (auto-generated
  # at startup and printed to stderr). Closes the "open registration during the
  # window between deploy and first registration" risk for public deploys.
  "require_setup_token": False,
  # CORS for cross-origin clients (native/WebView apps that bundle the frontend
  # and point at a remote server). Cross-origin requests use bearer tokens with
  # no cookies, so the origin carries no ambient authority and "*" exposes
  # nothing an unauthenticated HTTP client couldn't already reach. Set to a list
  # of exact origins (e.g. ["https://app.example.com"]) to restrict, or [] to
  # disable CORS entirely. We never send Access-Control-Allow-Credentials.
  "cors_origins": "*",
  # Reverse proxies whose forwarded client-IP headers are trusted. When the
  # TCP peer is one of these addresses, the client IP is read from X-Real-IP
  # (or the rightmost X-Forwarded-For entry) instead of the socket peer, so
  # the login rate limit, session records, audit log and access log see the
  # real client rather than the proxy. Off by default: a forwarded header is
  # client-supplied unless a proxy in front overwrites it, so trusting it
  # unconditionally would let clients spoof their IP. List only the proxy
  # actually in front (e.g. ["127.0.0.1"]). Env var takes a comma-separated
  # list.
  "trusted_proxies": [],
  # Off: robots.txt shuts every crawler out and there is no sitemap. On:
  # robots.txt allows the site and /sitemap.xml lists the published maps, so
  # search engines can find them. Link previews (canonical and og:image) are
  # written either way.
  "search_indexing": False,
  # The address the site is published at, such as "https://ferd.example.com".
  # When set, the canonical link, og:url, og:image, robots.txt and the sitemap
  # use it instead of the request's Host header, so a request naming another
  # host cannot put that host in a page a shared cache might keep.
  "public_url": None,
}


def parse_trusted_proxies(value) -> frozenset[str]:
  """Accepts a JSON list (config file) or comma-separated string (env var)."""
  if isinstance(value, str):
    value = value.split(",")
  return frozenset(v.strip() for v in (value or []) if v and v.strip())


def load_config(path: Path) -> dict:
  cfg = dict(DEFAULT_CONFIG)
  if path.exists():
    cfg.update(json.loads(path.read_text()))
  for key in cfg:
    env_key = "FERD_" + key.upper()
    if env_key in os.environ:
      raw = os.environ[env_key]
      if isinstance(cfg[key], bool):
        cfg[key] = raw.lower() in ("1", "true", "yes", "on")
      elif isinstance(cfg[key], int) and not isinstance(cfg[key], bool):
        cfg[key] = int(raw)
      else:
        cfg[key] = raw
  return cfg
