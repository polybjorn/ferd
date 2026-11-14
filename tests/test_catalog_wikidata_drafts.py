"""Tests for scripts/catalog-wikidata-drafts.py, against a canned SPARQL response with no network access."""

import email.message
import importlib.util
import unittest
import urllib.error
from unittest import mock
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
  "catalog_wikidata_drafts", Path(__file__).resolve().parent.parent / "scripts" / "catalog-wikidata-drafts.py")
drafts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(drafts)

WD = "http://www.wikidata.org/entity/"
FILEPATH = "http://commons.wikimedia.org/wiki/Special:FilePath/"


def row(item, **values):
  out = {"item": {"type": "uri", "value": WD + item}}
  for key, value in values.items():
    out[key] = {"type": "literal", "value": value}
  return out


# Shaped like a query.wikidata.org JSON answer: one row per combination of
# optional values, so an item with two types or two countries spans rows.
BINDINGS = [
  row("Q1", name="Rock Temple", coord="Point(31.625611 22.336944)", countryLabel="Egypt",
      image=FILEPATH + "Ramsis%2C%20Aswan%20Governorate%2C%20Egypt%20-%20panoramio.jpg",
      article="https://en.wikipedia.org/wiki/Rock_Temple", native="معبد", typeLabel="archaeological site"),
  row("Q1", name="Rock Temple", coord="Point(31.625611 22.336944)", countryLabel="Egypt",
      image=FILEPATH + "Ramsis%2C%20Aswan%20Governorate%2C%20Egypt%20-%20panoramio.jpg",
      article="https://en.wikipedia.org/wiki/Rock_Temple", native="معبد", typeLabel="temple"),
  row("Q2", name="Borderland Forest", coord="Point(23.8 52.7)", countryLabel="Poland", native="Borderland Forest",
      typeLabel="national park"),
  row("Q2", name="Borderland Forest", coord="Point(23.8 52.7)", countryLabel="Belarus", native="Borderland Forest",
      typeLabel="national park"),
  row("Q3", name="Already Shipped", coord="Point(1 2)", article="https://en.wikipedia.org/wiki/Abu_Simbel_temples"),
  row("Q4", name="abu simbel", coord="Point(3 4)"),
  row("Q5", name="Floating Idea"),
]

CATALOG = [{"name": "Abu Simbel", "sources": ["https://en.wikipedia.org/wiki/Abu_Simbel_temples"]}]


class FieldTests(unittest.TestCase):
  def test_point_is_lat_lon_rounded_to_5_decimals(self):
    self.assertEqual(drafts.parse_point("Point(31.625611 22.336944)"), (22.33694, 31.62561))
    self.assertEqual(drafts.parse_point("Point(-3.1234567 -40.5)"), (-40.5, -3.12346))
    self.assertIsNone(drafts.parse_point("garbage"))

  def test_thumb_matches_the_shipped_catalog_form(self):
    # Abu Simbel's image in catalog.json, built from its P18 value.
    name = drafts.commons_name(FILEPATH + "Ramsis%2C%20Aswan%20Governorate%2C%20Egypt%20-%20panoramio.jpg")
    self.assertEqual(drafts.thumb_url(name),
      "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b5/Ramsis%2C_Aswan_Governorate%2C_Egypt_-_panoramio.jpg"
      "/1280px-Ramsis%2C_Aswan_Governorate%2C_Egypt_-_panoramio.jpg")

  def test_svg_thumb_is_a_png(self):
    self.assertTrue(drafts.thumb_url("Map.svg").endswith("/1280px-Map.svg.png"))

  def test_category_is_suggested_from_the_narrowest_type(self):
    self.assertEqual(drafts.suggest_category(["national park"]), "nature")
    self.assertEqual(drafts.suggest_category(["urban park"]), "garden")
    self.assertEqual(drafts.suggest_category(["Fortified church", "castle"]), "castle")
    self.assertIsNone(drafts.suggest_category(["cultural landscape", "protected area"]))
    self.assertIsNone(drafts.suggest_category(["fortnight"]))


class DraftSetTests(unittest.TestCase):
  def setUp(self):
    self.out, self.counts = drafts.draft_set("unesco", BINDINGS, CATALOG)
    self.by_name = {d["name"]: d for d in self.out}

  def test_known_items_and_items_without_coordinates_are_skipped(self):
    self.assertEqual(sorted(self.by_name), ["Borderland Forest", "Rock Temple"])
    # Q3 by its Wikipedia link, Q4 by name, case-insensitively.
    self.assertEqual(self.counts, {"known": 2, "no_coordinates": 1, "duplicate_name": 0})

  def test_drafts_are_sorted_by_name(self):
    self.assertEqual([d["name"] for d in self.out], ["Borderland Forest", "Rock Temple"])

  def test_fields_from_wikidata(self):
    d = self.by_name["Rock Temple"]
    self.assertEqual((d["lat"], d["lon"], d["country"], d["local_name"]), (22.33694, 31.62561, "Egypt", "معبد"))
    self.assertEqual(d["sources"], ["https://en.wikipedia.org/wiki/Rock_Temple"])
    self.assertTrue(d["image"].startswith("https://upload.wikimedia.org/wikipedia/commons/thumb/b/b5/"))
    self.assertEqual(d["_wikidata"], WD + "Q1")
    self.assertEqual(d["_instance_of"], ["archaeological site", "temple"])
    self.assertEqual(d["_suggested_category"], "ruins")
    self.assertEqual(d["_suggested_tags"], ["UNESCO"])

  def test_local_name_equal_to_name_is_omitted(self):
    self.assertNotIn("local_name", self.by_name["Borderland Forest"])

  def test_several_countries_are_flagged_for_review(self):
    d = self.by_name["Borderland Forest"]
    self.assertEqual(d["country"], "Belarus")
    self.assertIn("several countries: Belarus, Poland", d["_review"])

  def test_human_fields_are_never_filled(self):
    for d in self.out:
      for field in ("category", "tags", "note"):
        self.assertNotIn(field, d)

  def test_limit(self):
    out, _ = drafts.draft_set("unesco", BINDINGS, CATALOG, limit=1)
    self.assertEqual([d["name"] for d in out], ["Borderland Forest"])

  def test_wikipedia_links_match_encoded_or_plain(self):
    links, names = drafts.known_keys([{"name": "X", "sources": ["https://en.wikipedia.org/wiki/K%C3%B6ln Cathedral"]}])
    self.assertTrue(drafts.is_known({"name": "Y", "sources": ["https://en.wikipedia.org/wiki/K%C3%B6ln_Cathedral"]}, links, names))
    self.assertFalse(drafts.is_known({"name": "Y", "sources": ["https://de.wikipedia.org/wiki/K%C3%B6ln_Cathedral"]}, links, names))


class CreditTests(unittest.TestCase):
  def draft(self, image):
    return {"name": "A", "lat": 1, "lon": 2, "image": drafts.thumb_url(image), "sources": ["s"], "_wikidata": "q"}

  def test_every_kept_image_carries_a_credit_in_catalog_order(self):
    ok, small, bad = self.draft("Ok.jpg"), self.draft("Small.jpg"), self.draft("Bad.jpg")
    calls = []

    def fetch(names):
      calls.append(names)
      return {
        "Ok.jpg": ({"Artist": {"value": "<b>Jane</b>"}, "LicenseShortName": {"value": "CC BY 4.0"}}, 4000),
        "Small.jpg": ({"Artist": {"value": "Ann"}, "LicenseShortName": {"value": "Public domain"}}, 800),
        "Bad.jpg": ({"Artist": {"value": "Joe"}}, 4000),
      }

    drafts.attach_credits([ok, small, bad], fetch=fetch, pause=0)
    self.assertEqual(calls, [["Ok.jpg", "Small.jpg", "Bad.jpg"]])
    self.assertEqual(list(ok), ["name", "lat", "lon", "image", "image_credit", "sources", "_wikidata"])
    self.assertEqual(ok["image_credit"], "Jane, CC BY 4.0")
    self.assertEqual(ok["image"], drafts.thumb_url("Ok.jpg"))
    # Commons does not scale up, so a file under 1280 px keeps its original.
    self.assertEqual(small["image"], drafts.original_url("Small.jpg"))
    self.assertEqual(small["image_credit"], "Ann, Public domain")
    self.assertNotIn("image", bad)
    self.assertNotIn("image_credit", bad)
    self.assertEqual(bad["_review"], ["image Bad.jpg dropped: no licence on Commons"])



class RateLimitTest(unittest.TestCase):
  def test_429_stops_without_a_second_request(self):
    headers = email.message.Message()
    headers["Retry-After"] = "300"
    err = urllib.error.HTTPError(drafts.SPARQL, 429, "Too Many Requests", headers, None)
    with mock.patch.object(drafts.urllib.request, "urlopen", side_effect=err) as urlopen:
      with self.assertRaises(drafts.RateLimited) as caught:
        drafts.run_query("unesco")
    self.assertEqual(caught.exception.wait, 300)
    self.assertEqual(urlopen.call_count, 1)

  def test_other_http_errors_pass_through(self):
    err = urllib.error.HTTPError(drafts.SPARQL, 500, "Server Error", email.message.Message(), None)
    with mock.patch.object(drafts.urllib.request, "urlopen", side_effect=err):
      with self.assertRaises(urllib.error.HTTPError):
        drafts.run_query("unesco")


if __name__ == "__main__":
  unittest.main()
