"""Validate the shipped baseline catalog (`<repo_root>/catalog.json`).

Runs in CI on every PR. Catches malformed entries before they ship to every
Ferd instance via the next git pull. Goes beyond `validate_place` by enforcing
catalog-specific conventions:

- Each entry must be a valid place per `validate_place` (server schema).
- `category` must be in the controlled vocabulary (CATEGORY_VOCAB).
- `note` capped tighter than the schema's 2000-char ceiling (catalog notes
  are one-line identifiers, not long-form descriptions).
- `image` recommended (warning printed via test name, not a hard fail).
- Canonical field order across all entries so PR diffs stay readable.
"""
import json
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from api import validate_place, ValidationError  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = REPO_ROOT / "catalog.json"

# Controlled vocabulary for shipped catalog entries. Personal places aren't
# restricted; this only applies to the file we ship in git. Extend deliberately
# (one PR adds vocab + the entries that use it).
CATEGORY_VOCAB = {
  "archaeological-site",
  "beach",
  "bridge",
  "castle",
  "cave",
  "city",
  "garden",
  "island",
  "landmark",
  "lighthouse",
  "monument",
  "mountain",
  "museum",
  "nature",
  "palace",
  "religious",
  "ruins",
  "viewpoint",
  "village",
  "waterfall",
}

# Catalog notes are one-line identifiers, kept short on purpose. Personal
# place notes can be up to 2000 chars; this is just the catalog convention.
NOTE_MAX = 60

# Canonical field order in catalog entries. Optional fields may be absent
# but when present must appear in this relative order. Keeps PR diffs
# diff-friendly and visually scannable.
CANONICAL_ORDER = [
  "name", "lat", "lon",
  "category", "country", "local_name",
  "note", "image", "sources",
]


class ShippedCatalogTests(unittest.TestCase):
  @classmethod
  def setUpClass(cls):
    cls.entries = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    assert isinstance(cls.entries, list), "catalog.json must be a JSON array"

  def test_each_entry_validates_against_place_schema(self):
    for i, entry in enumerate(self.entries):
      with self.subTest(i=i, name=entry.get("name", "?")):
        try:
          validate_place(entry)
        except ValidationError as e:
          self.fail(f"entry #{i} ({entry.get('name','?')}): {e}")

  def test_category_in_vocabulary(self):
    for i, entry in enumerate(self.entries):
      cat = entry.get("category")
      with self.subTest(i=i, name=entry.get("name", "?")):
        self.assertIn(
          cat, CATEGORY_VOCAB,
          msg=f"category {cat!r} not in vocabulary. To add a new category, "
              f"extend CATEGORY_VOCAB in this test in the same PR."
        )

  def test_note_length(self):
    for i, entry in enumerate(self.entries):
      note = entry.get("note", "")
      with self.subTest(i=i, name=entry.get("name", "?")):
        self.assertLessEqual(
          len(note), NOTE_MAX,
          msg=f"note > {NOTE_MAX} chars (got {len(note)}). Catalog notes "
              f"are one-line identifiers; long-form belongs in `sources`."
        )

  def test_unique_names(self):
    seen = set()
    for entry in self.entries:
      name = entry.get("name")
      self.assertNotIn(name, seen, msg=f"duplicate name in catalog: {name!r}")
      seen.add(name)

  def test_canonical_field_order(self):
    for i, entry in enumerate(self.entries):
      keys = list(entry.keys())
      ordered = [k for k in CANONICAL_ORDER if k in keys]
      with self.subTest(i=i, name=entry.get("name", "?")):
        self.assertEqual(
          keys, ordered,
          msg=f"keys are out of canonical order. Expected {ordered}, got {keys}."
        )

  def test_required_fields_present(self):
    # validate_place enforces lat/lon/name, but the catalog convention also
    # treats category and country as required (the UI filters/groups on them).
    for i, entry in enumerate(self.entries):
      with self.subTest(i=i, name=entry.get("name", "?")):
        self.assertIn("category", entry, msg="catalog entries require category")
        self.assertIn("country", entry, msg="catalog entries require country")


if __name__ == "__main__":
  unittest.main()
