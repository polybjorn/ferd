"""Unit tests for pure helpers in tools/api.py.

Run with: python3 -m unittest discover -s tests
"""

import io
import json
import sys
import tempfile
import tracemalloc
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import api  # noqa: E402


class TestValidUsername(unittest.TestCase):
  def test_alnum_ok(self):
    self.assertTrue(api._valid_username("alice"))
    self.assertTrue(api._valid_username("Alice123"))

  def test_underscore_and_hyphen_ok(self):
    self.assertTrue(api._valid_username("a_b-c"))

  def test_empty_rejected(self):
    self.assertFalse(api._valid_username(""))

  def test_too_long_rejected(self):
    self.assertFalse(api._valid_username("x" * (api.USERNAME_MAX + 1)))

  def test_special_chars_rejected(self):
    self.assertFalse(api._valid_username("a b"))
    self.assertFalse(api._valid_username("a$b"))
    self.assertFalse(api._valid_username("a.b"))


class TestValidPassword(unittest.TestCase):
  def test_within_bounds(self):
    self.assertTrue(api._valid_password("x" * api.PASSWORD_MIN))
    self.assertTrue(api._valid_password("x" * api.PASSWORD_MAX))

  def test_too_short(self):
    self.assertFalse(api._valid_password("x" * (api.PASSWORD_MIN - 1)))

  def test_too_long(self):
    self.assertFalse(api._valid_password("x" * (api.PASSWORD_MAX + 1)))


class TestSafePathComponent(unittest.TestCase):
  def test_valid(self):
    self.assertEqual(api.safe_path_component("route-01"), "route-01")
    self.assertEqual(api.safe_path_component("  spaced  "), "spaced")
    self.assertEqual(api.safe_path_component("rødt fjell (1)"), "rødt fjell (1)")

  def test_empty_rejected(self):
    with self.assertRaises(api.ValidationError):
      api.safe_path_component("")
    with self.assertRaises(api.ValidationError):
      api.safe_path_component("   ")

  def test_separators_rejected(self):
    for bad in ("a/b", "a\\b", "..", ".", "a\x00b"):
      with self.assertRaises(api.ValidationError):
        api.safe_path_component(bad)

  def test_non_string_rejected(self):
    with self.assertRaises(api.ValidationError):
      api.safe_path_component(123)  # type: ignore[arg-type]


class TestResolveUnder(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.base = Path(self.tmp.name).resolve()
    (self.base / "sub").mkdir()

  def tearDown(self):
    self.tmp.cleanup()

  def test_inside_base(self):
    r = api.resolve_under(self.base, "sub", "file.txt")
    self.assertEqual(r, self.base / "sub" / "file.txt")

  def test_base_itself(self):
    self.assertEqual(api.resolve_under(self.base), self.base)

  def test_escape_attempt_rejected(self):
    with self.assertRaises(api.ValidationError):
      api.resolve_under(self.base, "..", "etc")


class TestValidatePlace(unittest.TestCase):
  def minimal(self, **overrides):
    p = {"name": "Test", "lat": 1.0, "lon": 2.0, "category": "test"}
    p.update(overrides)
    return p

  def test_minimal_ok(self):
    out = api.validate_place(self.minimal())
    self.assertEqual(out["name"], "Test")
    self.assertEqual(out["lat"], 1.0)
    self.assertEqual(out["lon"], 2.0)
    self.assertEqual(out["category"], "test")
    self.assertFalse(out["visited"])

  def test_normalizes_strings(self):
    out = api.validate_place(self.minimal(name="  Padded  ", category=" cat "))
    self.assertEqual(out["name"], "Padded")
    self.assertEqual(out["category"], "cat")

  def test_int_lat_lon_coerced_to_float(self):
    out = api.validate_place(self.minimal(lat=1, lon=2))
    self.assertIsInstance(out["lat"], float)
    self.assertIsInstance(out["lon"], float)

  def test_full_record_ok(self):
    p = self.minimal(
      country="Norway",
      visited=True,
      note="seen it",
      local_name="Test (local)",
      sources=["https://example.com/x"],
    )
    out = api.validate_place(p)
    self.assertEqual(out["country"], "Norway")
    self.assertTrue(out["visited"])
    self.assertEqual(out["sources"], ["https://example.com/x"])

  def test_image_focus_preserved(self):
    # Regression: validate_place builds a normalized output that only includes
    # fields it explicitly lists. image_focus was missing from that list, so a
    # valid PUT silently dropped the value, leaving catalog updates with a
    # permanent "Update available" diff.
    for v in ("top", "bottom", "center", "left", "right", "50% 20%"):
      out = api.validate_place(self.minimal(image_focus=v))
      self.assertEqual(out["image_focus"], v, msg=f"image_focus {v!r} dropped during validate")

  def test_image_focus_invalid_rejected(self):
    for bad in ("topp", "100", "down", "50%", "50 50"):
      with self.assertRaises(api.ValidationError):
        api.validate_place(self.minimal(image_focus=bad))

  def test_image_focus_empty_stripped(self):
    # Empty/whitespace-only values are equivalent to "field not set" and must
    # not land in the stored output (would fail the no-empty-optional catalog
    # rule and clutter places.json).
    for empty in ("", "   ", "\t", None):
      out = api.validate_place(self.minimal(image_focus=empty))
      self.assertNotIn("image_focus", out)

  def test_tags_normalized(self):
    # Case preserved (first-seen casing wins), trimmed, deduped case-insensitively,
    # blanks dropped. "unesco" collapses into the earlier "UNESCO".
    out = api.validate_place(self.minimal(tags=["UNESCO", " free-entry ", "unesco", ""]))
    self.assertEqual(out["tags"], ["UNESCO", "free-entry"])

  def test_tags_empty_stripped(self):
    for empty in ([], None):
      out = api.validate_place(self.minimal(tags=empty))
      self.assertNotIn("tags", out)

  def test_tags_invalid_rejected(self):
    for bad in ("Has Space", "-leading", "x" * 33, "ümlaut", "under_score"):
      with self.assertRaises(api.ValidationError):
        api.validate_place(self.minimal(tags=[bad]))

  def test_tags_too_many_rejected(self):
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(tags=[f"t{i}" for i in range(11)]))

  def test_tags_non_list_rejected(self):
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(tags="unesco"))

  def test_non_dict_rejected(self):
    with self.assertRaises(api.ValidationError):
      api.validate_place("not a dict")

  def test_unknown_field_rejected(self):
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(extra="nope"))

  def test_missing_required(self):
    for missing in ("name", "lat", "lon"):
      p = self.minimal()
      del p[missing]
      with self.assertRaises(api.ValidationError):
        api.validate_place(p)

  def test_category_optional(self):
    # Omitted, null, or "" all mean uncategorized — the field is stripped.
    for absent in ({}, {"category": None}, {"category": ""}):
      p = self.minimal()
      del p["category"]
      p.update(absent)
      out = api.validate_place(p)
      self.assertNotIn("category", out)

  def test_name_bad(self):
    for bad in ("", "   ", "x" * 201, 123, None):
      with self.assertRaises(api.ValidationError):
        api.validate_place(self.minimal(name=bad))

  def test_lat_out_of_range(self):
    for bad in (-91, 91, "0", True, None):
      with self.assertRaises(api.ValidationError):
        api.validate_place(self.minimal(lat=bad))

  def test_lon_out_of_range(self):
    for bad in (-181, 181, "0", True, None):
      with self.assertRaises(api.ValidationError):
        api.validate_place(self.minimal(lon=bad))

  def test_category_bad(self):
    # "" and None are now treated as "uncategorized" (see test_category_optional).
    # Bad values are non-string types or strings that are whitespace-only / too long.
    for bad in ("   ", "x" * 65, 123):
      with self.assertRaises(api.ValidationError):
        api.validate_place(self.minimal(category=bad))

  def test_date_visited_and_rating_ok(self):
    out = api.validate_place(self.minimal(date_visited="2024-07-15", rating=4))
    self.assertEqual(out["date_visited"], "2024-07-15")
    self.assertEqual(out["rating"], 4)

  def test_date_visited_bad(self):
    # Regex-level validation (matches the route date_completed behavior). Bogus
    # months like 2024-13-01 pass the regex; that's a known limitation.
    for bad in ("2024/07/15", "yesterday", "07-15-2024", 123):
      with self.assertRaises(api.ValidationError):
        api.validate_place(self.minimal(date_visited=bad))

  def test_rating_bad(self):
    for bad in (0, 6, "4", True, 3.5):
      with self.assertRaises(api.ValidationError):
        api.validate_place(self.minimal(rating=bad))

  def test_country_bad(self):
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(country="x" * 101))
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(country=123))

  def test_visited_must_be_bool(self):
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(visited="yes"))

  def test_note_bad(self):
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(note="x" * 2001))

  def test_sources_bad(self):
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(sources="not a list"))
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(sources=["x" * 501]))
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(sources=["ftp://example.com"]))
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(sources=["javascript:alert(1)"]))
    with self.assertRaises(api.ValidationError):
      api.validate_place(self.minimal(sources=["x"] * 21))


class TestValidatePlaceMessages(unittest.TestCase):
  """index.html shows the server's `error` verbatim, so the message text is
  user-facing. Pin it per field group; the type-only tests above would stay
  green through a rewrite that degraded every message."""

  def minimal(self, **overrides):
    p = {"name": "Test", "lat": 1.0, "lon": 2.0}
    p.update(overrides)
    return p

  def assertMessage(self, place, expected):
    with self.assertRaises(api.ValidationError) as cm:
      api.validate_place(place)
    self.assertEqual(str(cm.exception), expected, msg=f"for {place!r}")

  def test_shape(self):
    self.assertMessage("nope", "place must be an object")
    self.assertMessage(self.minimal(extra=1, zzz=2), "unknown fields: ['extra', 'zzz']")
    self.assertMessage({"name": "x"}, "missing required fields: ['lat', 'lon']")
    # Unknown fields are reported before missing ones.
    self.assertMessage({"extra": 1}, "unknown fields: ['extra']")

  def test_required_fields(self):
    for bad in ("", "  ", "x" * 201, 1, None):
      self.assertMessage(self.minimal(name=bad), "name must be a non-empty string (<=200 chars)")
    for bad in (-91, 91, "0", True, None):
      self.assertMessage(self.minimal(lat=bad), "lat must be a number in [-90, 90]")
    for bad in (-181, 181, "0", True, None):
      self.assertMessage(self.minimal(lon=bad), "lon must be a number in [-180, 180]")
    # Fields are checked in a fixed order; the first failure wins.
    self.assertMessage(self.minimal(name="", lat=99, rating=9), "name must be a non-empty string (<=200 chars)")
    self.assertMessage(self.minimal(lat=99, lon=999), "lat must be a number in [-90, 90]")

  def test_category(self):
    for bad in ("   ", "x" * 65, 123):
      self.assertMessage(self.minimal(category=bad), "category, when set, must be a non-empty string (<=64 chars)")

  def test_optional_strings(self):
    for key, cap in (("country", 100), ("note", 2000), ("local_name", 200), ("from_catalog", 200)):
      for bad in ("x" * (cap + 1), 123, ["x"]):
        self.assertMessage(self.minimal(**{key: bad}), f"{key} must be a string (<={cap} chars) or null")

  def test_visited_date_rating(self):
    for bad in ("yes", 1, None):
      self.assertMessage(self.minimal(visited=bad), "visited must be boolean")
    for bad in ("2024/07/15", "yesterday", 123):
      self.assertMessage(self.minimal(date_visited=bad), "date_visited must be YYYY-MM-DD")
    for bad in (0, 6, "4", True, 3.5):
      self.assertMessage(self.minimal(rating=bad), "rating must be an integer 1-5")

  def test_sources(self):
    self.assertMessage(self.minimal(sources="x"), "sources must be a list (<=20 items)")
    self.assertMessage(self.minimal(sources=None), "sources must be a list (<=20 items)")
    self.assertMessage(self.minimal(sources=["https://a.b"] * 21), "sources must be a list (<=20 items)")
    self.assertMessage(self.minimal(sources=[1]), "each source must be a string (<=500 chars)")
    self.assertMessage(self.minimal(sources=["https://a.b/" + "x" * 500]), "each source must be a string (<=500 chars)")
    self.assertMessage(self.minimal(sources=["ftp://a.b"]), "each source must be an http(s) URL")

  def test_tags(self):
    self.assertMessage(self.minimal(tags="unesco"), "tags must be a list of strings")
    self.assertMessage(self.minimal(tags=[1]), "each tag must be a string")
    self.assertMessage(
      self.minimal(tags=["has space"]),
      "invalid tag: 'has space' (alphanumerics + hyphen, 1-32 chars, starts with alphanumeric)",
    )
    self.assertMessage(self.minimal(tags=[f"t{i}" for i in range(11)]), "too many tags (max 10)")

  def test_image(self):
    for bad in (1, "https://a.b/" + "x" * 1000):
      self.assertMessage(self.minimal(image=bad), "image must be a string (<=1000 chars) or null")
    self.assertMessage(self.minimal(image="data:x"), "image must be an http(s) URL")
    self.assertMessage(self.minimal(image_focus=1), "image_focus must be a string")
    self.assertMessage(
      self.minimal(image_focus="topp"),
      "image_focus must be one of top/bottom/center/left/right or 'N% N%'",
    )

  def test_catalog_skip(self):
    for bad in ("x", [], {f"k{i}": 1 for i in range(21)}):
      self.assertMessage(self.minimal(catalog_skip=bad), "catalog_skip must be an object (<=20 entries)")
    for bad in ({"": 1}, {"x" * 65: 1}):
      self.assertMessage(self.minimal(catalog_skip=bad), "catalog_skip keys must be non-empty strings (<=64 chars)")
    self.assertMessage(self.minimal(catalog_skip={"k": {"a": 1}}), "catalog_skip values must be JSON scalars or lists")
    self.assertMessage(self.minimal(catalog_skip={"k": [1] * 51}), "catalog_skip list values capped at 50 items")
    for bad in ([None], [[1]], ["x" * 501]):
      self.assertMessage(
        self.minimal(catalog_skip={"k": bad}),
        "catalog_skip list items must be JSON scalars (strings <=500 chars)",
      )

  def test_id(self):
    for bad in ("ABCDEF12", "abc", 12345678):
      self.assertMessage(self.minimal(id=bad), "id must be an 8-char hex string")

  def test_full_normalized_output(self):
    # Pins the returned shape for every field so a rewrite of the output
    # builder cannot drop or reshape one.
    out = api.validate_place({
      "id": "0123abcd", "name": " N ", "lat": 1, "lon": -2, "category": " c ",
      "country": " NO ", "visited": True, "note": " n ", "local_name": " l ",
      "sources": ["https://a.b"], "date_visited": "2024-01-02", "rating": 3,
      "image": " https://i.b/x.jpg ", "image_focus": " 10% 20% ", "tags": ["a", "A", "b"],
      "from_catalog": " Cat ", "catalog_skip": {"note": "x"},
    })
    self.assertEqual(out, {
      "name": "N", "lat": 1.0, "lon": -2.0, "visited": True, "id": "0123abcd",
      "category": "c", "country": "NO", "note": "n", "local_name": "l",
      "sources": ["https://a.b"], "image": "https://i.b/x.jpg", "from_catalog": "Cat",
      "image_focus": "10% 20%", "date_visited": "2024-01-02", "rating": 3,
      "catalog_skip": {"note": "x"}, "tags": ["a", "b"],
    })
    # Nulls and empties are dropped rather than stored, except a string
    # field set to "", which is kept as "".
    out = api.validate_place(self.minimal(
      id="", category="", country=None, note=None, local_name=None, image="",
      image_focus="", date_visited="", rating="", tags=[], from_catalog=None, catalog_skip={},
    ))
    self.assertEqual(out, {"name": "Test", "lat": 1.0, "lon": 2.0, "visited": False, "image": ""})


class TestWriteAndLoadJsonFile(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.base = Path(self.tmp.name)

  def tearDown(self):
    self.tmp.cleanup()

  def test_round_trip_dict(self):
    p = self.base / "x.json"
    api.write_json_file(p, {"a": 1, "b": "two"})
    out = api.load_json_file(p, expected_type=dict, required=True, label="x.json")
    self.assertEqual(out, {"a": 1, "b": "two"})

  def test_round_trip_list(self):
    p = self.base / "x.json"
    api.write_json_file(p, [1, 2, 3])
    out = api.load_json_file(p, expected_type=list, required=True, label="x.json")
    self.assertEqual(out, [1, 2, 3])

  def test_pretty_printed_with_trailing_newline(self):
    p = self.base / "x.json"
    api.write_json_file(p, {"a": 1})
    text = p.read_text(encoding="utf-8")
    self.assertTrue(text.endswith("\n"))
    self.assertIn("\n", text)  # indented

  def test_unicode_preserved(self):
    p = self.base / "x.json"
    api.write_json_file(p, {"name": "Røvær"})
    self.assertIn("Røvær", p.read_text(encoding="utf-8"))

  def test_missing_optional_returns_default(self):
    p = self.base / "missing.json"
    self.assertEqual(api.load_json_file(p, expected_type=list, required=False, label="x"), [])
    self.assertEqual(api.load_json_file(p, expected_type=dict, required=False, label="x"), {})

  def test_missing_required_raises(self):
    p = self.base / "missing.json"
    with self.assertRaises(api.ValidationError):
      api.load_json_file(p, expected_type=list, required=True, label="x")

  def test_corrupt_json_raises(self):
    p = self.base / "bad.json"
    p.write_text("{ not valid", encoding="utf-8")
    with self.assertRaises(api.ValidationError):
      api.load_json_file(p, expected_type=dict, required=True, label="x")

  def test_wrong_type_raises(self):
    p = self.base / "shape.json"
    api.write_json_file(p, {"a": 1})
    with self.assertRaises(api.ValidationError):
      api.load_json_file(p, expected_type=list, required=True, label="x")


class TestAtomicWriteBytes(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.base = Path(self.tmp.name)

  def tearDown(self):
    self.tmp.cleanup()

  def test_creates_parent_dirs(self):
    p = self.base / "a" / "b" / "x.txt"
    api.atomic_write_bytes(p, b"hi")
    self.assertEqual(p.read_bytes(), b"hi")

  def test_overwrites_existing(self):
    p = self.base / "x.txt"
    p.write_bytes(b"old")
    api.atomic_write_bytes(p, b"new")
    self.assertEqual(p.read_bytes(), b"new")

  def test_preserves_symlink(self):
    target = self.base / "real.txt"
    target.write_bytes(b"original")
    link = self.base / "link.txt"
    link.symlink_to(target)
    api.atomic_write_bytes(link, b"updated")
    self.assertTrue(link.is_symlink())
    self.assertEqual(target.read_bytes(), b"updated")


class TestStripGpxPii(unittest.TestCase):
  GPX = (
    b'<?xml version="1.0" encoding="UTF-8"?>'
    b'<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="MyDevice">'
    b"<metadata><time>2024-01-01T00:00:00Z</time>"
    b"<author><name>Alice</name></author></metadata>"
    b'<trk><name>Route</name><trkseg>'
    b'<trkpt lat="60.0" lon="5.0"><time>2024-01-01T00:00:01Z</time><ele>10</ele></trkpt>'
    b'<trkpt lat="60.1" lon="5.1"><ele>20</ele></trkpt>'
    b"</trkseg></trk></gpx>"
  )

  def test_strips_time_author_creator(self):
    out = api.strip_gpx_pii(self.GPX)
    self.assertNotIn(b"<time>", out)
    self.assertNotIn(b"<author>", out)
    self.assertNotIn(b"creator=", out)

  def test_preserves_track_and_elevation(self):
    out = api.strip_gpx_pii(self.GPX)
    self.assertIn(b"<trk", out)
    self.assertIn(b"Route", out)
    self.assertIn(b"<ele>10</ele>", out)
    self.assertIn(b"<ele>20</ele>", out)
    self.assertIn(b'lat="60.0"', out)

  def test_invalid_xml_rejected(self):
    with self.assertRaises(api.ValidationError):
      api.strip_gpx_pii(b"not xml")

  def test_wrong_root_rejected(self):
    with self.assertRaises(api.ValidationError):
      api.strip_gpx_pii(b'<?xml version="1.0"?><kml/>')

  def test_deep_nesting_rejected(self):
    # The handler catches ValidationError only, so a RecursionError here used
    # to drop the connection with no response (#31).
    deep = (b'<gpx xmlns="http://www.topografix.com/GPX/1/1">'
            + b"<a>" * 2000 + b"</a>" * 2000 + b"</gpx>")
    with self.assertRaises(api.ValidationError):
      api.strip_gpx_pii(deep)
    with self.assertRaises(api.ValidationError):
      api.validate_gpx(deep)


class TestReadZipEntryBounded(unittest.TestCase):
  def _entry(self, data: bytes):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
      zf.writestr("places.json", data)
    zf = zipfile.ZipFile(io.BytesIO(buf.getvalue()))
    return zf, zf.infolist()[0]

  def _peak_while_rejected(self, zf, info, limit: int) -> int:
    tracemalloc.start()
    try:
      with self.assertRaises(api.ValidationError):
        api.read_zip_entry_bounded(zf, info, limit)
      return tracemalloc.get_traced_memory()[1]
    finally:
      tracemalloc.stop()

  def test_reads_entry_within_limit(self):
    zf, info = self._entry(b"[]")
    self.assertEqual(api.read_zip_entry_bounded(zf, info, 1024), b"[]")

  def test_stops_at_limit(self):
    zf, info = self._entry(b"\0" * (32 * 1024 * 1024))
    self.assertLess(self._peak_while_rejected(zf, info, 1024 * 1024), 4 * 1024 * 1024)

  def test_lying_declared_size_stays_bounded(self):
    # The declared size is the uploader's claim, so it can't be what bounds
    # the read (#30).
    zf, info = self._entry(b"\0" * (32 * 1024 * 1024))
    info.file_size = 1
    self.assertLess(self._peak_while_rejected(zf, info, 1024 * 1024), 4 * 1024 * 1024)


class TestPasswordHash(unittest.TestCase):
  """Minimal round-trip only; PBKDF2 is slow (~300ms per call)."""

  def test_round_trip(self):
    salt, digest = api.hash_password("correct horse battery staple")
    self.assertTrue(api.verify_password("correct horse battery staple", salt, digest))
    self.assertFalse(api.verify_password("wrong password", salt, digest))


class TestParseBind(unittest.TestCase):
  def test_host_port(self):
    self.assertEqual(api.parse_bind("127.0.0.1:8090"), ("127.0.0.1", 8090))

  def test_port_only_defaults_host(self):
    self.assertEqual(api.parse_bind(":8090"), ("127.0.0.1", 8090))

  def test_ipv6_ish(self):
    # Last colon wins (rpartition).
    self.assertEqual(api.parse_bind("::1:8090"), ("::1", 8090))


class TestSafeXmlFromString(unittest.TestCase):
  def test_plain_gpx_parses(self):
    xml = b'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>t</name></trk></gpx>'
    root = api._safe_xml_fromstring(xml)
    self.assertTrue(root.tag.endswith("gpx"))

  def test_doctype_rejected(self):
    xml = b'<?xml version="1.0"?><!DOCTYPE gpx><gpx/>'
    with self.assertRaises(api.ValidationError):
      api._safe_xml_fromstring(xml)

  def test_internal_entity_rejected(self):
    xml = (b'<?xml version="1.0"?>'
           b'<!DOCTYPE lolz [<!ENTITY lol "lol">]>'
           b'<gpx>&lol;</gpx>')
    with self.assertRaises(api.ValidationError):
      api._safe_xml_fromstring(xml)

  def test_billion_laughs_rejected(self):
    xml = (b'<?xml version="1.0"?>'
           b'<!DOCTYPE lolz ['
           b'<!ENTITY lol "lol">'
           b'<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">'
           b']>'
           b'<gpx>&lol2;</gpx>')
    with self.assertRaises(api.ValidationError):
      api._safe_xml_fromstring(xml)

  def test_malformed_xml_rejected(self):
    with self.assertRaises(api.ValidationError):
      api._safe_xml_fromstring(b"<gpx><unclosed>")


if __name__ == "__main__":
  unittest.main()
