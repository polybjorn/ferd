"""Content-Security-Policy for the shell, and the parser for violation reports.

The app sends the policy itself because the Docker image has no proxy in front
of it, so a header set only in an nginx example would reach nobody running the
image. It goes on the document (index.html and the /u/ pages that serve it) and
on sw.js, whose response gives the service worker its own policy.

Two environment variables, read on every response so a restart picks them up:

- FERD_CSP replaces the policy. `{importmap}` in it becomes the hash of the
  inline import map in index.html, which script-src has to allow.
- FERD_CSP_MODE is `report-only` (the default) or `enforce`.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from pathlib import Path

DEFAULT_POLICY = (
  "default-src 'self'; "
  "script-src 'self' {importmap}; "
  "style-src 'self'; "
  # Place images are any URL a user pastes, and tiles come from every host in
  # site-config.json, so images and fetches take any https origin.
  "img-src 'self' data: blob: https:; "
  "connect-src 'self' https:; "
  "worker-src 'self'; "
  "manifest-src 'self'; "
  "object-src 'none'; "
  "base-uri 'none'; "
  "form-action 'self'; "
  "frame-ancestors 'none'"
)

REPORT_PATH = "/api/csp-report"
REPORT_GROUP = "csp"
REPORT_DIRECTIVES = f"report-uri {REPORT_PATH}; report-to {REPORT_GROUP}"

# The longest report body read, and the longest field logged from it.
REPORT_MAX_BYTES = 8192
REPORT_FIELD_MAX = 200

# At most this many reports per client IP in REPORT_RATE_WINDOW seconds.
REPORT_RATE_MAX = 30
REPORT_RATE_WINDOW = 60

_IMPORTMAP_RE = re.compile(rb'<script type="importmap">(.*?)</script>', re.S)

_hash_cache: dict = {"key": None, "value": ""}


def importmap_hash(html: bytes) -> str:
  """The CSP source for the inline import map in `html`, or "" with none."""
  m = _IMPORTMAP_RE.search(html)
  if not m:
    return ""
  digest = base64.b64encode(hashlib.sha256(m.group(1)).digest()).decode("ascii")
  return f"'sha256-{digest}'"


def importmap_hash_for(index: Path) -> str:
  """importmap_hash of the file at `index`, cached until its mtime changes."""
  try:
    key = (str(index), index.stat().st_mtime_ns)
  except OSError:
    return ""
  if _hash_cache["key"] != key:
    try:
      _hash_cache["value"] = importmap_hash(index.read_bytes())
    except OSError:
      return ""
    _hash_cache["key"] = key
  return _hash_cache["value"]


def policy(importmap: str, env=os.environ) -> str:
  """The policy value, with the import map hash and the report directives."""
  value = (env.get("FERD_CSP") or "").strip() or DEFAULT_POLICY
  value = value.replace("{importmap}", importmap)
  value = " ".join(value.split()).rstrip(";").strip()
  if "report-uri" not in value and "report-to" not in value:
    value = f"{value}; {REPORT_DIRECTIVES}"
  return value


def header_name(env=os.environ) -> str:
  """Content-Security-Policy under FERD_CSP_MODE=enforce, else Report-Only."""
  if (env.get("FERD_CSP_MODE") or "").strip().lower() == "enforce":
    return "Content-Security-Policy"
  return "Content-Security-Policy-Report-Only"


def headers(importmap: str, env=os.environ) -> list[tuple[str, str]]:
  """The response headers that carry the policy."""
  return [
    (header_name(env), policy(importmap, env)),
    ("Reporting-Endpoints", f'{REPORT_GROUP}="{REPORT_PATH}"'),
  ]


def _clean(value) -> str:
  text = "" if value is None else str(value)
  text = "".join(c if c.isprintable() else "?" for c in text)
  return text[:REPORT_FIELD_MAX]


def _reporting_api_entry(item) -> dict | None:
  """One Reporting API csp-violation entry, or None for any other entry."""
  if not isinstance(item, dict) or item.get("type") != "csp-violation":
    return None
  body = item.get("body")
  if not isinstance(body, dict):
    return None
  return {
    "blocked": body.get("blockedURL"),
    "directive": body.get("effectiveDirective"),
    "source": body.get("sourceFile"),
    "line": body.get("lineNumber"),
  }


def parse_reports(raw: bytes, ctype: str) -> list[dict]:
  """The violations in a report body, as dicts of blocked, directive, source
  and line. Accepts the report-uri shape (application/csp-report) and the
  Reporting API shape (application/reports+json). WebKit sends a single
  Reporting API entry as application/csp-report, so that type takes it too.
  Raises ValueError on anything else."""
  try:
    data = json.loads(raw.decode("utf-8"))
  except (UnicodeDecodeError, json.JSONDecodeError) as e:
    raise ValueError("not json") from e
  out = []
  if ctype == "application/csp-report":
    body = data.get("csp-report") if isinstance(data, dict) else None
    if isinstance(body, dict):
      out.append({
        "blocked": body.get("blocked-uri"),
        "directive": body.get("effective-directive") or body.get("violated-directive"),
        "source": body.get("source-file"),
        "line": body.get("line-number"),
      })
    else:
      entry = _reporting_api_entry(data)
      if entry is None:
        raise ValueError("no csp-report")
      out.append(entry)
  elif ctype == "application/reports+json":
    if not isinstance(data, list):
      raise ValueError("not a list")
    out.extend(e for e in map(_reporting_api_entry, data[:10]) if e is not None)
  else:
    raise ValueError("unsupported content type")
  return [{k: _clean(v) for k, v in r.items()} for r in out]
