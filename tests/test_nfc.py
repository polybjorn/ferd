"""Tests for the merge of routes stored under decomposed (NFD) names.

Run with: python3 -m unittest discover -s tests
"""

import json
import sys
import tempfile
import unicodedata
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from ferd_api import store  # noqa: E402
from ferd_api.common import nfc_component  # noqa: E402
from ferd_api.db import db_connect, db_init  # noqa: E402
from ferd_api.nfc import merge_metadata, merge_nfd_routes  # noqa: E402
from ferd_api.users import create_user  # noqa: E402

NFC_NAME = unicodedata.normalize("NFC", "Kjølen–Åsen")
NFD_NAME = unicodedata.normalize("NFD", NFC_NAME)
NFC_REGION = unicodedata.normalize("NFC", "Måløy")
NFD_REGION = unicodedata.normalize("NFD", NFC_REGION)
GPX = b'<gpx version="1.1"><trk><name>a</name></trk></gpx>'
OTHER_GPX = b'<gpx version="1.1"><trk><name>b</name></trk></gpx>'


class NfcCase(unittest.TestCase):
  def setUp(self):
    self._tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self._tmp.cleanup)
    root = Path(self._tmp.name)
    self.udir = root / "user"
    self.gpx = self.udir / "gpx"
    self.gpx.mkdir(parents=True)
    self.conn = db_connect(str(root / "t.db"))
    db_init(self.conn)
    self.uid = create_user(self.conn, "bob", "correct-horse-battery", fresh=False)
    self.assertNotEqual(NFC_NAME, NFD_NAME)
    self.assertNotEqual(NFC_REGION, NFD_REGION)

  def put_gpx(self, region, name, data=GPX, suffix=".gpx"):
    d = self.gpx / region if region else self.gpx
    d.mkdir(exist_ok=True)
    (d / (name + suffix)).write_bytes(data)

  def meta(self, key, data):
    store.put_item(self.conn, self.uid, "metadata", key, data)

  def files(self):
    return sorted(str(p.relative_to(self.gpx)) for p in self.gpx.rglob("*") if p.is_file())

  def metadata(self):
    return store.get_map(self.conn, self.uid, "metadata")


class TestNormalisedNames(unittest.TestCase):
  def test_component_is_composed(self):
    self.assertEqual(nfc_component(NFD_NAME), NFC_NAME)
    self.assertEqual(nfc_component(NFC_NAME), NFC_NAME)


class TestMergeMetadata(unittest.TestCase):
  def test_union_of_fields(self):
    merged, conflicts = merge_metadata([{"source": "https://x.test/"}, {"rating": 4, "difficulty": "hard"}])
    self.assertEqual(merged, {"source": "https://x.test/", "rating": 4, "difficulty": "hard"})
    self.assertEqual(conflicts, [])

  def test_tags_merge_as_a_set(self):
    merged, conflicts = merge_metadata([{"tags": ["summit", "lake"]}, {"tags": ["Lake", "ridge"]}])
    self.assertEqual(merged["tags"], ["summit", "lake", "ridge"])
    self.assertEqual(conflicts, [])

  def test_a_field_with_two_values_is_a_conflict(self):
    _merged, conflicts = merge_metadata([{"rating": 3}, {"rating": 5, "notes": "a"}, {"notes": "b"}])
    self.assertEqual(conflicts, ["rating", "notes"])


class TestMergePass(NfcCase):
  def test_identical_pair_merges_into_the_composed_key(self):
    self.put_gpx(NFC_REGION, NFC_NAME)
    self.put_gpx(NFC_REGION, NFD_NAME)
    self.meta(f"{NFC_REGION}/{NFC_NAME}", {"source": "https://x.test/"})
    self.meta(f"{NFC_REGION}/{NFD_NAME}", {"rating": 4, "date_completed": "2025-07-01"})

    merged = merge_nfd_routes(self.conn, self.uid, self.udir)

    key = f"{NFC_REGION}/{NFC_NAME}"
    self.assertEqual(merged, [key])
    self.assertEqual(self.files(), [f"{NFC_REGION}/{NFC_NAME}.gpx"])
    self.assertEqual(self.metadata(), {key: {"source": "https://x.test/", "rating": 4, "date_completed": "2025-07-01"}})

  def test_pass_is_idempotent(self):
    self.put_gpx("", NFC_NAME)
    self.put_gpx("", NFD_NAME)
    self.meta(NFD_NAME, {"rating": 2})
    merge_nfd_routes(self.conn, self.uid, self.udir)
    head = store.head_rev(self.conn, self.uid)
    files = self.files()
    self.assertEqual(merge_nfd_routes(self.conn, self.uid, self.udir), [])
    self.assertEqual(store.head_rev(self.conn, self.uid), head)
    self.assertEqual(self.files(), files)
    self.assertEqual(self.metadata(), {NFC_NAME: {"rating": 2}})

  def test_planned_track_pair_merges(self):
    # The NFC copy has the walked track, the NFD copy the same walked track
    # plus the planned one under its own spelling.
    self.put_gpx(NFC_REGION, NFC_NAME)
    self.put_gpx(NFC_REGION, NFD_NAME)
    self.put_gpx(NFC_REGION, NFD_NAME, OTHER_GPX, suffix=".planned.gpx")
    merge_nfd_routes(self.conn, self.uid, self.udir)
    self.assertEqual(self.files(), sorted([f"{NFC_REGION}/{NFC_NAME}.gpx", f"{NFC_REGION}/{NFC_NAME}.planned.gpx"]))
    self.assertEqual((self.gpx / NFC_REGION / f"{NFC_NAME}.planned.gpx").read_bytes(), OTHER_GPX)

  def test_equal_planned_tracks_under_both_spellings_merge(self):
    for name in (NFC_NAME, NFD_NAME):
      self.put_gpx("", name, suffix=".planned.gpx")
    merge_nfd_routes(self.conn, self.uid, self.udir)
    self.assertEqual(self.files(), [f"{NFC_NAME}.planned.gpx"])

  def test_decomposed_region_folder_moves(self):
    self.put_gpx(NFD_REGION, NFD_NAME)
    self.meta(f"{NFD_REGION}/{NFD_NAME}", {"rating": 5})
    merge_nfd_routes(self.conn, self.uid, self.udir)
    self.assertEqual(self.files(), [f"{NFC_REGION}/{NFC_NAME}.gpx"])
    self.assertFalse((self.gpx / NFD_REGION).exists())
    self.assertEqual(self.metadata(), {f"{NFC_REGION}/{NFC_NAME}": {"rating": 5}})

  def test_different_gpx_bytes_are_left_alone(self):
    self.put_gpx("", NFC_NAME)
    self.put_gpx("", NFD_NAME, OTHER_GPX)
    self.meta(NFD_NAME, {"rating": 4})
    self.assertEqual(merge_nfd_routes(self.conn, self.uid, self.udir), [])
    self.assertEqual(self.files(), sorted([f"{NFC_NAME}.gpx", f"{NFD_NAME}.gpx"]))
    self.assertEqual(self.metadata(), {NFD_NAME: {"rating": 4}})

  def test_conflicting_metadata_keeps_both_copies(self):
    self.put_gpx("", NFC_NAME)
    self.put_gpx("", NFD_NAME)
    self.meta(NFC_NAME, {"rating": 3, "source": "https://x.test/"})
    self.meta(NFD_NAME, {"rating": 5})
    self.assertEqual(merge_nfd_routes(self.conn, self.uid, self.udir), [])
    self.assertEqual(self.files(), sorted([f"{NFC_NAME}.gpx", f"{NFD_NAME}.gpx"]))
    self.assertEqual(self.metadata(), {NFC_NAME: {"rating": 3, "source": "https://x.test/"}, NFD_NAME: {"rating": 5}})

  def test_composed_routes_are_untouched(self):
    self.put_gpx(NFC_REGION, NFC_NAME)
    self.meta(f"{NFC_REGION}/{NFC_NAME}", {"rating": 1})
    head = store.head_rev(self.conn, self.uid)
    self.assertEqual(merge_nfd_routes(self.conn, self.uid, self.udir), [])
    self.assertEqual(store.head_rev(self.conn, self.uid), head)

  def test_no_gpx_folder_is_a_no_op(self):
    self.gpx.rmdir()
    self.assertEqual(merge_nfd_routes(self.conn, self.uid, self.udir), [])
    self.assertFalse((self.udir / ".gpx.lock").exists())


if __name__ == "__main__":
  unittest.main()
