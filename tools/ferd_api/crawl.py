"""What crawlers and link previews read: robots.txt, the sitemap and the
canonical and og:image tags in the page head.

Link previews are always on: a shared link to a published map gets a canonical
URL and an image, which exposes nothing a link holder cannot already open.
Indexing is opt-in per instance with `search_indexing`. Off, robots.txt shuts
every crawler out and there is no sitemap; on, robots.txt allows the site and
names a sitemap of the published maps.

Every URL is built from the request's origin, so one install answers for
whatever name it is reached by.
"""

from __future__ import annotations

import html
import re
from urllib.parse import quote, unquote
from xml.sax.saxutils import escape as xml_escape

# Substituted into index.html on serve. A comment, so a copy of the page served
# from disk without the API carries nothing broken.
SHARE_TAGS_PLACEHOLDER = "<!-- __FERD_SHARE_TAGS__ -->"

OG_IMAGE_PATH = "/icons/icon-512.png"

# A hostname or an IPv4 or bracketed IPv6 address, with an optional port. The
# Host header is client-supplied, so anything else is refused rather than
# written into a page.
_HOST_RE = re.compile(r"^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$")


def origin(scheme: str, host: str | None) -> str | None:
  """`scheme://host`, or None when the host is missing or malformed."""
  host = (host or "").strip()
  if scheme not in ("http", "https") or not _HOST_RE.match(host):
    return None
  return f"{scheme}://{host.lower()}"


def canonical_path(path: str) -> str:
  """The canonical path of a page the shell serves: a published map's
  `/u/<username>/`, whatever follows it, and `/` for everything else."""
  if path.startswith("/u/"):
    name = unquote(path[len("/u/"):].split("/", 1)[0])
    if name:
      return "/u/" + quote(name, safe="") + "/"
  return "/"


def share_tags(origin_url: str | None, path: str) -> str:
  """The canonical link and og:image for the page at `path`, or nothing when
  the origin is unknown."""
  if not origin_url:
    return ""
  canonical = html.escape(origin_url + canonical_path(path), quote=True)
  image = html.escape(origin_url + OG_IMAGE_PATH, quote=True)
  return (f'<link rel="canonical" href="{canonical}">\n'
          f'  <meta property="og:url" content="{canonical}">\n'
          f'  <meta property="og:image" content="{image}">')


def robots_txt(origin_url: str | None, indexing: bool) -> str:
  if not indexing:
    return "User-agent: *\nDisallow: /\n"
  lines = ["User-agent: *", "Allow: /", "Allow: /u/"]
  if origin_url:
    lines += ["", f"Sitemap: {origin_url}/sitemap.xml"]
  return "\n".join(lines) + "\n"


def sitemap_xml(origin_url: str | None, usernames: list[str]) -> str:
  """A sitemap of the published maps. Empty when the origin is unknown, since
  a sitemap takes absolute URLs only."""
  urls = []
  if origin_url:
    for name in usernames:
      loc = xml_escape(origin_url + "/u/" + quote(name, safe="") + "/")
      urls.append(f"  <url><loc>{loc}</loc></url>")
  return ('<?xml version="1.0" encoding="UTF-8"?>\n'
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
          + "".join(u + "\n" for u in urls)
          + "</urlset>\n")
