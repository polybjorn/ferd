#!/usr/bin/env python3
"""Fill `image_credit` on shipped catalog entries from Wikimedia Commons.

Reads each Commons file's Artist and LicenseShortName and writes
"<author>, <licence>" into catalog.json. Entries that already carry a credit
are left alone unless --refresh is given. Non-Commons images are skipped and
listed, since their credit has to be written by hand.

  python3 scripts/catalog-image-credits.py [--refresh] [--dry-run] [catalog.json]
"""

import argparse
import html.parser
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://commons.wikimedia.org/w/api.php"
# Commons asks automated clients for a descriptive User-Agent.
USER_AGENT = "ferd-catalog-credits/1.0 (https://github.com/polybjorn/ferd)"
BATCH = 50
NO_AUTHOR = re.compile(r"^No machine-readable author provided\. (.+?)(?:~commonswiki)? assumed\b")
COMMONS_PATH = re.compile(r"^/wikipedia/commons/(?:thumb/)?[0-9a-f]/[0-9a-f]{2}/([^/]+)")


def commons_file(url):
  """Return the Commons file name an upload.wikimedia.org URL points at, or None."""
  p = urllib.parse.urlparse(url or "")
  if p.netloc != "upload.wikimedia.org":
    return None
  m = COMMONS_PATH.match(p.path)
  return urllib.parse.unquote(m.group(1)) if m else None


class _Text(html.parser.HTMLParser):
  def __init__(self):
    super().__init__()
    self.parts = []

  def handle_data(self, data):
    self.parts.append(data)


def plain_text(markup):
  parser = _Text()
  parser.feed(markup or "")
  return " ".join("".join(parser.parts).split())


def credit_from_extmetadata(meta):
  """Build "<author>, <licence>" from a Commons extmetadata dict, or None."""
  author = plain_text((meta.get("Artist") or {}).get("value", ""))
  # Commons fills Artist with this sentence when the file page names no
  # author; the uploader it assumes is the useful part.
  assumed = NO_AUTHOR.match(author)
  if assumed:
    author = assumed.group(1)
  licence = plain_text((meta.get("LicenseShortName") or {}).get("value", ""))
  if not licence:
    return None
  # Author fields can hold a whole biography; the credit has to fit under a
  # 280 px popup image.
  if len(author) > 120:
    author = author[:117].rstrip() + "..."
  return f"{author}, {licence}" if author else licence


def fetch_extmetadata(names):
  """Map each file name to its extmetadata dict for one batch of names."""
  params = {
    "action": "query", "format": "json", "formatversion": "2",
    "prop": "imageinfo", "iiprop": "extmetadata",
    "iiextmetadatafilter": "Artist|LicenseShortName",
    "titles": "|".join("File:" + n for n in names),
  }
  req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params), headers={"User-Agent": USER_AGENT})
  with urllib.request.urlopen(req, timeout=30) as resp:
    doc = json.load(resp)
  q = doc.get("query", {})
  # The API answers under the normalized title (underscores become spaces).
  back = {n["to"]: n["from"] for n in q.get("normalized", [])}
  out = {}
  for page in q.get("pages", []):
    title = back.get(page.get("title"), page.get("title", ""))
    info = page.get("imageinfo") or []
    if info:
      out[title[len("File:"):]] = info[0].get("extmetadata", {})
  return out


def insert_after(entry, after_keys, key, value):
  """Return a copy of entry with key placed after the last present after_key."""
  out = {}
  anchor = next((k for k in reversed(after_keys) if k in entry), None)
  for k, v in entry.items():
    if k == key:
      continue
    out[k] = v
    if k == anchor:
      out[key] = value
  if key not in out:
    out[key] = value
  return out


def main():
  ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
  ap.add_argument("catalog", nargs="?", default=str(Path(__file__).resolve().parent.parent / "catalog.json"))
  ap.add_argument("--refresh", action="store_true", help="rewrite credits that are already set")
  ap.add_argument("--dry-run", action="store_true", help="print changes without writing")
  args = ap.parse_args()

  path = Path(args.catalog)
  entries = json.loads(path.read_text(encoding="utf-8"))
  todo, manual = {}, []
  for i, e in enumerate(entries):
    if not e.get("image") or (e.get("image_credit") and not args.refresh):
      continue
    name = commons_file(e["image"])
    if name is None:
      manual.append(e["name"])
    else:
      todo.setdefault(name, []).append(i)

  names = list(todo)
  changed, missing = 0, []
  for start in range(0, len(names), BATCH):
    chunk = names[start:start + BATCH]
    meta = fetch_extmetadata(chunk)
    for n in chunk:
      credit = credit_from_extmetadata(meta.get(n, {}))
      for i in todo[n]:
        if credit is None:
          missing.append(entries[i]["name"])
          continue
        if entries[i].get("image_credit") != credit:
          entries[i] = insert_after(entries[i], ["image", "image_focus"], "image_credit", credit)
          changed += 1
          if args.dry_run:
            print(f"{entries[i]['name']}: {credit}")
    time.sleep(1)

  if not args.dry_run and changed:
    path.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
  print(f"{changed} credits {'would change' if args.dry_run else 'written'}", file=sys.stderr)
  for label, items in (("no licence on Commons", missing), ("not a Commons image", manual)):
    if items:
      print(f"{label}: {', '.join(items)}", file=sys.stderr)
  return 1 if missing or manual else 0


if __name__ == "__main__":
  sys.exit(main())
