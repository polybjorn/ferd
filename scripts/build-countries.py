#!/usr/bin/env python3
"""Build vendor/natural-earth/ from a Natural Earth admin-0 GeoJSON.

Input: ne_10m_admin_0_countries.geojson from the natural-earth-vector repo at
the tag named in vendor/NOTICES.md. Output, both committed:

  countries.geo.json   one feature per ISO 3166-1 alpha-2 code, simplified,
                       properties {"code": "NO"} only. Loaded by the browser
                       when the visited-countries layer is on.
  country-names.json   {normalised name: code}, read by tools/api.py to turn
                       a place's free-text country into a code.
  country-list.json    {code: display name}, the choices in the place form's
                       country picker.

Usage: python3 scripts/build-countries.py <ne_10m_admin_0_countries.geojson>

Stdlib only. Re-run after bumping the Natural Earth tag or editing ALIASES.
"""

import json
import sys
import unicodedata
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "vendor" / "natural-earth"

# Douglas-Peucker tolerance and output precision, in degrees. 0.02 degrees is
# about 2 km, which holds fjords and islands at the last zoom the fill shows,
# in a file of about 650 KB gzipped.
TOLERANCE = 0.02
PRECISION = 3

# English primary names win over the translated ones when two codes claim
# the same string; a string claimed twice within one tier is dropped rather
# than guessed.
ENGLISH_FIELDS = ("NAME", "NAME_LONG", "ADMIN", "GEOUNIT", "SUBUNIT", "BRK_NAME",
                  "FORMAL_EN", "NAME_SORT", "NAME_ALT", "NAME_CIAWF", "NAME_EN")
OTHER_FIELDS = ("NAME_DE", "NAME_ES", "NAME_FR", "NAME_HU", "NAME_ID", "NAME_IT",
                "NAME_NL", "NAME_PL", "NAME_PT", "NAME_SV", "NAME_TR", "NAME_VI")

# Common spellings Natural Earth does not carry. These sit in the English tier.
ALIASES = {
  "AE": ["UAE", "Emirates"],
  "BA": ["Bosnia"],
  "CD": ["DRC", "DR Congo", "Congo-Kinshasa", "Congo (Kinshasa)"],
  "CG": ["Congo-Brazzaville", "Congo (Brazzaville)", "Republic of Congo"],
  "CI": ["Ivory Coast", "Cote d'Ivoire"],
  "CV": ["Cape Verde", "Cabo Verde"],
  "CZ": ["Czech Republic", "Czechia"],
  "DK": ["Danmark"],
  "FI": ["Suomi"],
  "GB": ["UK", "U.K.", "Great Britain", "Britain", "England", "Scotland", "Wales", "Northern Ireland"],
  "IS": ["Island"],
  "KP": ["North Korea"],
  "KR": ["South Korea"],
  "LA": ["Laos"],
  "MK": ["Macedonia", "North Macedonia"],
  "MM": ["Burma", "Myanmar"],
  "NL": ["Holland"],
  "NO": ["Norge", "Noreg"],
  "PS": ["Palestine"],
  "RU": ["Russia"],
  "SE": ["Sverige"],
  "SZ": ["Swaziland", "Eswatini"],
  "TL": ["East Timor"],
  "TR": ["Turkey", "Turkiye"],
  "US": ["USA", "U.S.A.", "US", "U.S.", "United States", "United States of America", "America"],
  "VA": ["Vatican", "Vatican City", "Holy See"],
  "VN": ["Vietnam", "Viet Nam"],
}


# Display names where ADMIN, the default, reads badly in a picker.
DISPLAY = {
  "AX": "Åland Islands",
  "BL": "Saint Barthélemy",
  "BS": "Bahamas",
  "FM": "Micronesia",
  "HK": "Hong Kong",
  "MO": "Macau",
  "RS": "Serbia",
  "ST": "São Tomé and Príncipe",
  "SZ": "Eswatini",
  "TZ": "Tanzania",
  "US": "United States",
  "VI": "U.S. Virgin Islands",
}


def norm(name: str) -> str:
  """Must match normalise_country_name in tools/api.py and normCountryName
  in app/countries.js."""
  s = unicodedata.normalize("NFKD", name)
  s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
  s = s.replace("&", " and ").replace(".", "").replace("'", "").replace("’", "")
  s = " ".join(s.replace(",", " ").split())
  if s.startswith("the "):
    s = s[4:]
  return s


def code_of(props: dict):
  code = props.get("ISO_A2_EH") or props.get("ISO_A2")
  return code if isinstance(code, str) and len(code) == 2 and code.isalpha() else None


def _perp(p, a, b):
  (x, y), (x1, y1), (x2, y2) = p, a, b
  dx, dy = x2 - x1, y2 - y1
  if dx == 0 and dy == 0:
    return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
  return abs(dy * x - dx * y + x2 * y1 - y2 * x1) / (dx * dx + dy * dy) ** 0.5


def simplify(points, tol):
  """Iterative Douglas-Peucker; keeps the first and last point."""
  keep = [False] * len(points)
  keep[0] = keep[-1] = True
  stack = [(0, len(points) - 1)]
  while stack:
    i, j = stack.pop()
    best, idx = 0.0, None
    for k in range(i + 1, j):
      d = _perp(points[k], points[i], points[j])
      if d > best:
        best, idx = d, k
    if idx is not None and best > tol:
      keep[idx] = True
      stack += [(i, idx), (idx, j)]
  return [p for p, k in zip(points, keep) if k]


def ring_out(ring):
  pts = simplify(ring, TOLERANCE)
  out = []
  for x, y in pts:
    q = [round(x, PRECISION), round(y, PRECISION)]
    if not out or out[-1] != q:
      out.append(q)
  if len(out) < 4 or out[0] != out[-1]:
    return None
  return out


def polygons_of(geom):
  return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def build(src: Path):
  data = json.loads(src.read_text("utf-8"))
  shapes, tiers, primary = {}, ({}, {}), {}
  for f in data["features"]:
    props = f["properties"]
    code = code_of(props)
    if not code:
      continue
    polys = polygons_of(f["geometry"])
    shapes.setdefault(code, []).extend(polys)
    # One code can span several features, as Australia and its territories do.
    size = sum(len(ring) for poly in polys for ring in poly)
    if size > primary.get(code, (0, ""))[0]:
      primary[code] = (size, props["ADMIN"])
    for tier, fields in zip(tiers, (ENGLISH_FIELDS, OTHER_FIELDS)):
      for field in fields:
        if isinstance(props.get(field), str) and props[field].strip():
          tier.setdefault(norm(props[field]), set()).add(code)
  for code, names in ALIASES.items():
    for name in names:
      tiers[0].setdefault(norm(name), set()).add(code)
  for code, name in DISPLAY.items():
    tiers[0].setdefault(norm(name), set()).add(code)
  for code in shapes:
    # A bare code ("NO", "us") is unambiguous, so it matches too.
    tiers[0].setdefault(norm(code), set()).add(code)

  names = {}
  for tier in tiers:
    for name, codes in tier.items():
      if name and len(codes) == 1 and name not in names:
        names[name] = next(iter(codes))

  display = {code: DISPLAY.get(code, primary[code][1]) for code in sorted(shapes)}
  unresolved = [name for code, name in display.items() if names.get(norm(name)) != code]
  if unresolved:
    sys.exit(f"display names that do not resolve to their code: {unresolved}")

  features = []
  for code in sorted(shapes):
    polys = []
    for poly in shapes[code]:
      outer = ring_out(poly[0])
      if outer is None:
        continue
      polys.append([outer] + [r for r in map(ring_out, poly[1:]) if r])
    if not polys:
      # A microstate smaller than the tolerance: keep its largest ring as is.
      biggest = max((p[0] for p in shapes[code]), key=len)
      polys = [[[[round(x, PRECISION), round(y, PRECISION)] for x, y in biggest]]]
    features.append({"type": "Feature", "properties": {"code": code},
                     "geometry": {"type": "MultiPolygon", "coordinates": polys}})

  OUT.mkdir(parents=True, exist_ok=True)
  (OUT / "countries.geo.json").write_text(
    json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")) + "\n", "utf-8")
  (OUT / "country-names.json").write_text(
    json.dumps(dict(sorted(names.items())), ensure_ascii=False, indent=0) + "\n", "utf-8")
  (OUT / "country-list.json").write_text(
    json.dumps(display, ensure_ascii=False, indent=0) + "\n", "utf-8")
  print(f"{len(features)} countries, {len(names)} names", file=sys.stderr)


if __name__ == "__main__":
  if len(sys.argv) != 2:
    sys.exit(__doc__)
  build(Path(sys.argv[1]))
