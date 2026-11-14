"""Tests for scripts/catalog-image-credits.py, with no network access."""

import importlib.util
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
  "catalog_image_credits", Path(__file__).resolve().parent.parent / "scripts" / "catalog-image-credits.py")
credits = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(credits)


def meta(artist, licence):
  return {"Artist": {"value": artist}, "LicenseShortName": {"value": licence}}


class CommonsFileTests(unittest.TestCase):
  def test_thumb_and_original_urls(self):
    base = "https://upload.wikimedia.org/wikipedia/commons/"
    self.assertEqual(credits.commons_file(base + "thumb/d/de/Colosseo_2020.jpg/1280px-Colosseo_2020.jpg"), "Colosseo_2020.jpg")
    self.assertEqual(credits.commons_file(base + "d/de/Colosseo_2020.jpg"), "Colosseo_2020.jpg")

  def test_percent_encoding_is_decoded(self):
    url = "https://upload.wikimedia.org/wikipedia/commons/thumb/1/16/A%27s_%281%29.jpg/1280px-thumbnail.jpg"
    self.assertEqual(credits.commons_file(url), "A's_(1).jpg")

  def test_other_hosts_are_not_commons(self):
    self.assertIsNone(credits.commons_file("https://example.org/wikipedia/commons/d/de/X.jpg"))
    self.assertIsNone(credits.commons_file(""))


class CreditTests(unittest.TestCase):
  def test_author_markup_is_stripped(self):
    m = meta('<a href="//commons.wikimedia.org/wiki/User:Jane">Jane  Doe</a>', "CC BY-SA 4.0")
    self.assertEqual(credits.credit_from_extmetadata(m), "Jane Doe, CC BY-SA 4.0")

  def test_assumed_uploader_replaces_the_boilerplate(self):
    m = meta("No machine-readable author provided. Preslav~commonswiki assumed (based on copyright claims).", "Public domain")
    self.assertEqual(credits.credit_from_extmetadata(m), "Preslav, Public domain")

  def test_missing_author_keeps_the_licence(self):
    self.assertEqual(credits.credit_from_extmetadata(meta("", "CC0")), "CC0")

  def test_missing_licence_gives_no_credit(self):
    self.assertIsNone(credits.credit_from_extmetadata(meta("Jane", "")))
    self.assertIsNone(credits.credit_from_extmetadata({}))

  def test_long_author_is_cut(self):
    out = credits.credit_from_extmetadata(meta("x" * 300, "CC BY 4.0"))
    self.assertLessEqual(len(out), 120 + len(", CC BY 4.0"))


class InsertAfterTests(unittest.TestCase):
  def test_goes_after_the_last_present_anchor(self):
    e = {"name": "A", "image": "u", "image_focus": "top", "sources": []}
    out = credits.insert_after(e, ["image", "image_focus"], "image_credit", "c")
    self.assertEqual(list(out), ["name", "image", "image_focus", "image_credit", "sources"])

  def test_replaces_an_existing_value_in_place(self):
    e = {"image": "u", "image_credit": "old", "sources": []}
    out = credits.insert_after(e, ["image", "image_focus"], "image_credit", "new")
    self.assertEqual(out, {"image": "u", "image_credit": "new", "sources": []})
    self.assertEqual(list(out), ["image", "image_credit", "sources"])


if __name__ == "__main__":
  unittest.main()
