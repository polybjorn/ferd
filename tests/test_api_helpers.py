"""Unit tests for pure helpers in tools/api.py.

Run with: python3 -m unittest discover -s tests
"""

import json
import sys
import tempfile
import unittest
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
    self.assertEqual(api.safe_path_component("trail-01"), "trail-01")
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
    # Regex-level validation (matches the trail date_hiked behavior). Bogus
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
    b'<trk><name>Trail</name><trkseg>'
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
    self.assertIn(b"Trail", out)
    self.assertIn(b"<ele>10</ele>", out)
    self.assertIn(b"<ele>20</ele>", out)
    self.assertIn(b'lat="60.0"', out)

  def test_invalid_xml_rejected(self):
    with self.assertRaises(api.ValidationError):
      api.strip_gpx_pii(b"not xml")

  def test_wrong_root_rejected(self):
    with self.assertRaises(api.ValidationError):
      api.strip_gpx_pii(b'<?xml version="1.0"?><kml/>')


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


if __name__ == "__main__":
  unittest.main()
