"""Validate the shipped route catalog (`<repo_root>/catalog-routes.json`).

Each entry names an OpenStreetMap relation and carries hand-written metadata
only; the geometry is fetched when a user imports it (tools/ferd_api/osm.py).
"""
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from ferd_api import ValidationError, country_code_for  # noqa: E402
from ferd_api.osm import ROUTE_CATALOG_FIELDS, validate_route_entry  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
ROUTES_PATH = REPO_ROOT / "catalog-routes.json"

# Same one-line convention as the place catalog.
NOTE_MAX = 60

# Anything that looks like coordinates means geometry crept into the file.
GEOMETRY_KEYS = re.compile(r'"(lat|lon|coordinates|geometry|points)"')


class ShippedRoutesTests(unittest.TestCase):
  # tests/test_shipped_areas.py runs the same checks on catalog-areas.json.
  PATH = ROUTES_PATH
  FIELDS = ROUTE_CATALOG_FIELDS
  validate = staticmethod(validate_route_entry)

  @classmethod
  def setUpClass(cls):
    cls.text = cls.PATH.read_text(encoding="utf-8")
    cls.entries = json.loads(cls.text)

  def test_is_a_non_empty_list(self):
    self.assertIsInstance(self.entries, list)
    self.assertGreater(len(self.entries), 0)

  def test_each_entry_validates(self):
    for i, e in enumerate(self.entries):
      with self.subTest(i=i, name=e.get("name", "?") if isinstance(e, dict) else "?"):
        try:
          self.validate(e)
        except ValidationError as err:
          self.fail(str(err))

  def test_no_geometry_shipped(self):
    self.assertIsNone(GEOMETRY_KEYS.search(self.text), f"{self.PATH.name} holds relation IDs, not geometry")

  def test_country_resolves_to_a_code(self):
    for e in self.entries:
      with self.subTest(name=e["name"]):
        self.assertIsNotNone(country_code_for(e["country"]), e["country"])

  def test_note_length(self):
    for e in self.entries:
      if "note" in e:
        with self.subTest(name=e["name"]):
          self.assertLessEqual(len(e["note"]), NOTE_MAX)

  def test_unique_names_and_relations(self):
    names = [e["name"].lower() for e in self.entries]
    rels = [e["relation"] for e in self.entries]
    self.assertEqual(len(names), len(set(names)), "duplicate name")
    self.assertEqual(len(rels), len(set(rels)), "duplicate relation")

  def test_alphabetical_order(self):
    names = [e["name"] for e in self.entries]
    self.assertEqual(names, sorted(names, key=str.lower))

  def test_canonical_field_order(self):
    for e in self.entries:
      with self.subTest(name=e["name"]):
        keys = list(e)
        self.assertEqual(keys, [k for k in self.FIELDS if k in e])


class RouteEntryValidationTests(unittest.TestCase):
  GOOD = {"name": "Trail", "relation": 1, "country": "Norway"}

  def test_good(self):
    validate_route_entry(dict(self.GOOD))

  def test_rejects(self):
    bad = [
      {"name": "Trail", "country": "Norway"},
      dict(self.GOOD, relation="1"),
      dict(self.GOOD, relation=True),
      dict(self.GOOD, relation=0),
      dict(self.GOOD, lat=1.0),
      dict(self.GOOD, name=""),
      dict(self.GOOD, sources=[]),
      dict(self.GOOD, sources=["ftp://x"]),
      dict(self.GOOD, image="javascript:alert(1)"),
    ]
    for e in bad:
      with self.subTest(e=e):
        with self.assertRaises(ValidationError):
          validate_route_entry(e)


if __name__ == "__main__":
  unittest.main()
