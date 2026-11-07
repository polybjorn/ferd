"""Tests for the SQLite item store and the one-time JSON migration.

Run with: python3 -m unittest discover -s tests
"""

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from ferd_api import store  # noqa: E402
from ferd_api.common import ValidationError  # noqa: E402
from ferd_api.db import db_connect, db_init, db_migrate  # noqa: E402
from ferd_api.migrate import edited_after_migration, ensure_migrated, migrate_user  # noqa: E402
from ferd_api.transfer import ImportPayload, import_replace  # noqa: E402
from ferd_api.users import create_user  # noqa: E402


def _hashes(udir: Path) -> dict:
  return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(udir.glob("*.json"))}


class StoreCase(unittest.TestCase):
  def setUp(self):
    self._tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self._tmp.cleanup)
    self.root = Path(self._tmp.name)
    self.udir = self.root / "user"
    self.udir.mkdir()
    self.conn = db_connect(str(self.root / "t.db"))
    db_init(self.conn)
    self.uid = create_user(self.conn, "bob", "correct-horse-battery", fresh=False)

  def epoch(self):
    return store.get_epoch(self.conn, self.uid)

  def write(self, name, data):
    (self.udir / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


class TestMigration(StoreCase):
  def seed(self):
    self.write("places.json", [
      {"id": "aaaaaaaa", "name": "One", "lat": 1, "lon": 2},
      {"name": "No id", "lat": 3, "lon": 4},
      {"id": "aaaaaaaa", "name": "Dup id", "lat": 5, "lon": 6},
    ])
    self.write("areas.json", [{"name": "Park", "geometry": {"type": "Polygon", "coordinates": []}}])
    self.write("metadata.json", {"R/t": {"rating": 4}, "u": {"notes": "n"}})
    self.write("prefs.json", {"theme": "dark"})
    self.write("category-labels.json", {"hut": {"label": "Hut"}})
    self.write("routes.json", {"regions": [{"name": "R", "routes": [{"key": "R/t", "name": "t", "file": "gpx/R/t.gpx", "points": 3}]}]})

  def test_rows_match_json(self):
    self.seed()
    self.assertTrue(migrate_user(self.conn, self.uid, self.udir))
    places = store.list_items(self.conn, self.uid, "place")
    self.assertEqual([p["name"] for p in places], ["One", "No id", "Dup id"])
    self.assertEqual(len({p["id"] for p in places}), 3)
    self.assertEqual(places[0]["id"], "aaaaaaaa")
    self.assertEqual(len(store.list_items(self.conn, self.uid, "area")), 1)
    self.assertEqual(store.get_map(self.conn, self.uid, "metadata"), {"R/t": {"rating": 4}, "u": {"notes": "n"}})
    self.assertEqual(store.get_map(self.conn, self.uid, "pref"), {"theme": "dark"})
    self.assertEqual(store.get_map(self.conn, self.uid, "label"), {"hut": {"label": "Hut"}})
    routes = store.routes_manifest(self.conn, self.uid)
    self.assertEqual(routes["regions"][0]["routes"][0]["name"], "t")
    self.assertEqual(routes["regions"][0]["routes"][0]["rating"], 4)

  def test_json_left_untouched(self):
    self.seed()
    before = _hashes(self.udir)
    migrate_user(self.conn, self.uid, self.udir)
    self.assertEqual(_hashes(self.udir), before)

  def test_idempotent(self):
    self.seed()
    self.assertTrue(migrate_user(self.conn, self.uid, self.udir))
    rows = self.conn.execute("SELECT kind, id, rev, data FROM store_items ORDER BY kind, id").fetchall()
    head = store.head_rev(self.conn, self.uid)
    self.assertFalse(migrate_user(self.conn, self.uid, self.udir))
    self.write("places.json", [{"id": "bbbbbbbb", "name": "Later", "lat": 0, "lon": 0}])
    self.assertFalse(migrate_user(self.conn, self.uid, self.udir))
    self.assertEqual(self.conn.execute("SELECT kind, id, rev, data FROM store_items ORDER BY kind, id").fetchall(), rows)
    self.assertEqual(store.head_rev(self.conn, self.uid), head)

  def test_unreadable_file_leaves_nothing_and_recovers(self):
    self.seed()
    (self.udir / "metadata.json").write_text("{not json", encoding="utf-8")
    with self.assertRaises(ValidationError):
      migrate_user(self.conn, self.uid, self.udir)
    self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM store_items").fetchone()[0], 0)
    self.assertIsNone(self.conn.execute("SELECT 1 FROM store_migrated").fetchone())
    self.write("metadata.json", {"R/t": {"rating": 4}})
    ensure_migrated(self.conn, self.uid, self.udir)
    self.assertEqual(store.count_items(self.conn, self.uid, "place"), 3)

  def test_missing_user_folder_defers(self):
    gone = self.root / "missing"
    with self.assertRaises(ValidationError):
      migrate_user(self.conn, self.uid, gone)
    self.assertIsNone(self.conn.execute("SELECT 1 FROM store_migrated").fetchone())
    self.assertFalse(gone.exists())
    gone.mkdir()
    self.assertTrue(migrate_user(self.conn, self.uid, gone))

  def test_new_user_is_born_migrated(self):
    other = create_user(self.conn, "amy", "correct-horse-battery")
    self.assertFalse(migrate_user(self.conn, other, self.root / "no-such-folder"))

  def test_non_utf8_file_is_a_validation_error_naming_it(self):
    (self.udir / "places.json").write_bytes(b"[\xff\xfe]")
    with self.assertRaises(ValidationError) as ctx:
      migrate_user(self.conn, self.uid, self.udir)
    self.assertIn("user/places.json", str(ctx.exception))
    self.assertIn("UTF-8", str(ctx.exception))
    self.assertIsNone(self.conn.execute("SELECT 1 FROM store_migrated").fetchone())

  def test_counts_per_kind(self):
    self.seed()
    counts = migrate_user(self.conn, self.uid, self.udir)
    self.assertEqual(counts, {"places": 3, "areas": 1, "metadata": 2, "routes": 1, "prefs": 1, "labels": 1})

  def test_edits_after_migration_are_reported(self):
    self.seed()
    migrate_user(self.conn, self.uid, self.udir)
    self.assertEqual(edited_after_migration(self.conn, self.uid, self.udir), [])
    later = time.time() + 60
    os.utime(self.udir / "places.json", (later, later))
    os.utime(self.udir / "routes.json", (later, later))
    self.assertEqual(edited_after_migration(self.conn, self.uid, self.udir), ["places.json"])

  def test_rows_without_marker_are_completed(self):
    # One transaction rules out a crash leaving this state, but a hand-restored
    # database could; the insert must neither duplicate nor fail.
    self.seed()
    store.put_item(self.conn, self.uid, "pref", "theme", "dark")
    self.assertTrue(migrate_user(self.conn, self.uid, self.udir))
    self.assertEqual(store.count_items(self.conn, self.uid, "place"), 3)
    self.assertEqual(store.get_map(self.conn, self.uid, "pref"), {"theme": "dark"})

  def test_empty_dir_migrates_to_nothing(self):
    self.assertTrue(migrate_user(self.conn, self.uid, self.udir))
    self.assertEqual(store.head_rev(self.conn, self.uid), 0)
    self.assertEqual(store.list_items(self.conn, self.uid, "place"), [])

  def test_changes_feed_covers_migrated_rows(self):
    self.seed()
    migrate_user(self.conn, self.uid, self.udir)
    feed = store.changes_since(self.conn, self.uid, 0, 1000)
    kinds = {c["kind"] for c in feed["changes"]}
    self.assertEqual(kinds, {"place", "area", "metadata", "pref", "label", "route"})
    self.assertEqual(feed["rev"], store.head_rev(self.conn, self.uid))


class TestPublicUserFolder(StoreCase):
  def test_url_spelling_never_names_a_folder(self):
    from ferd_api.handlers.public import PublicMixin
    from ferd_api.handlers.request import RequestMixin

    db_migrate(self.conn)
    self.conn.execute("UPDATE users SET published=1")
    self.conn.execute("INSERT INTO store_migrated(user_id, migrated_at) VALUES (?, 0)", (self.uid,))
    conn, cfg = self.conn, {"data_dir": str(self.root)}

    class Stub(PublicMixin, RequestMixin):
      pass

    Stub.conn, Stub.cfg = conn, cfg
    stub = Stub.__new__(Stub)
    found = stub._public_user("BOB")
    self.assertEqual(found[0], self.uid)
    self.assertEqual(found[1].name, "bob")
    self.assertEqual(list((self.root / "users").glob("*")) if (self.root / "users").exists() else [], [])


class TestChangeFeed(StoreCase):
  def test_tombstone_and_since(self):
    r1, _ = store.put_item(self.conn, self.uid, "place", "aaaaaaaa", {"id": "aaaaaaaa", "name": "A"})
    r2, _ = store.put_item(self.conn, self.uid, "place", "bbbbbbbb", {"id": "bbbbbbbb", "name": "B"})
    r3 = store.delete_item(self.conn, self.uid, "place", "aaaaaaaa")
    self.assertTrue(r1 < r2 < r3)
    feed = store.changes_since(self.conn, self.uid, r2, 100, self.epoch())
    self.assertEqual(len(feed["changes"]), 1)
    change = feed["changes"][0]
    self.assertEqual((change["id"], change["deleted"], change["rev"]), ("aaaaaaaa", True, r3))
    self.assertNotIn("data", change)
    self.assertEqual(feed["rev"], r3)
    self.assertFalse(feed["reset"])

  def test_identical_put_is_a_noop(self):
    r, changed = store.put_item(self.conn, self.uid, "pref", "k", {"a": 1})
    r2, changed2 = store.put_item(self.conn, self.uid, "pref", "k", {"a": 1})
    self.assertTrue(changed)
    self.assertFalse(changed2)
    self.assertEqual(r, r2)

  def test_delete_of_missing_item_changes_nothing(self):
    self.assertIsNone(store.delete_item(self.conn, self.uid, "place", "cccccccc"))
    self.assertEqual(store.head_rev(self.conn, self.uid), 0)

  def test_put_resurrects_a_tombstone(self):
    store.put_item(self.conn, self.uid, "place", "aaaaaaaa", {"id": "aaaaaaaa", "name": "A"})
    store.delete_item(self.conn, self.uid, "place", "aaaaaaaa")
    r, changed = store.put_item(self.conn, self.uid, "place", "aaaaaaaa", {"id": "aaaaaaaa", "name": "A"})
    self.assertTrue(changed)
    self.assertEqual(store.count_items(self.conn, self.uid, "place"), 1)
    feed = store.changes_since(self.conn, self.uid, 0, 100)
    self.assertEqual([(c["deleted"], c["rev"]) for c in feed["changes"]], [(False, r)])

  def test_since_beyond_head_resets(self):
    store.put_item(self.conn, self.uid, "pref", "k", 1)
    feed = store.changes_since(self.conn, self.uid, 999, 100)
    self.assertTrue(feed["reset"])
    self.assertEqual(len(feed["changes"]), 1)

  def test_missing_or_other_epoch_resets(self):
    store.put_item(self.conn, self.uid, "pref", "k", 1)
    head = store.head_rev(self.conn, self.uid)
    for epoch in (None, "not-this-one"):
      feed = store.changes_since(self.conn, self.uid, head, 100, epoch)
      self.assertTrue(feed["reset"], epoch)
      self.assertEqual(len(feed["changes"]), 1)
      self.assertEqual(feed["epoch"], self.epoch())
    feed = store.changes_since(self.conn, self.uid, head, 100, self.epoch())
    self.assertFalse(feed["reset"])
    self.assertEqual(feed["changes"], [])

  def test_epoch_is_stable_and_per_user(self):
    first = self.epoch()
    store.put_item(self.conn, self.uid, "pref", "k", 1)
    self.assertEqual(self.epoch(), first)
    other = create_user(self.conn, "amy", "correct-horse-battery")
    self.assertNotEqual(store.get_epoch(self.conn, other), first)

  def test_feed_carries_pos_and_a_move_is_a_change(self):
    store.put_item(self.conn, self.uid, "place", "aaaaaaaa", {"id": "aaaaaaaa", "name": "A"})
    store.put_item(self.conn, self.uid, "place", "bbbbbbbb", {"id": "bbbbbbbb", "name": "B"})
    head = store.head_rev(self.conn, self.uid)
    feed = store.changes_since(self.conn, self.uid, 0, 100, self.epoch())
    self.assertEqual([(c["id"], c["pos"]) for c in feed["changes"]], [("aaaaaaaa", 1), ("bbbbbbbb", 2)])
    rev, changed = store.put_item(self.conn, self.uid, "place", "aaaaaaaa", {"id": "aaaaaaaa", "name": "A"}, pos=5)
    self.assertTrue(changed)
    self.assertGreater(rev, head)
    feed = store.changes_since(self.conn, self.uid, head, 100, self.epoch())
    self.assertEqual([(c["id"], c["pos"]) for c in feed["changes"]], [("aaaaaaaa", 5)])

  def test_paging(self):
    for i in range(5):
      store.put_item(self.conn, self.uid, "pref", f"k{i}", i)
    first = store.changes_since(self.conn, self.uid, 0, 2, self.epoch())
    self.assertTrue(first["more"])
    self.assertEqual(len(first["changes"]), 2)
    second = store.changes_since(self.conn, self.uid, first["next"], 10, self.epoch())
    self.assertFalse(second["more"])
    self.assertEqual(len(second["changes"]), 3)

  def test_users_are_independent(self):
    other = create_user(self.conn, "amy", "correct-horse-battery")
    store.put_item(self.conn, self.uid, "pref", "k", 1)
    self.assertEqual(store.head_rev(self.conn, other), 0)
    self.assertEqual(store.changes_since(self.conn, other, 0, 10)["changes"], [])


class TestRouteManifest(StoreCase):
  def manifest(self, *keys):
    routes = [{"key": k, "name": k.split("/")[-1], "points": 2} for k in keys]
    return {"regions": [{"name": "R", "routes": routes}]}

  def test_script_ignores_the_frozen_metadata_file(self):
    (self.udir / "gpx" / "R").mkdir(parents=True)
    (self.udir / "gpx" / "R" / "t.gpx").write_text(
      '<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><name>t</name><trkseg>'
      '<trkpt lat="60" lon="5"/><trkpt lat="60.1" lon="5.1"/></trkseg></trk></gpx>', encoding="utf-8")
    self.write("metadata.json", {"R/t": {"rating": 5}})
    script = Path(__file__).resolve().parent.parent / "scripts" / "gpx-manifest.sh"
    subprocess.run(["sh", str(script), str(self.udir)], check=True, capture_output=True)
    route = json.loads((self.udir / "routes.json").read_text(encoding="utf-8"))["regions"][0]["routes"][0]
    self.assertEqual(route["key"], "R/t")
    self.assertNotIn("rating", route)
    (self.udir / "metadata.json").unlink()
    subprocess.run(["sh", str(script), str(self.udir)], check=True, capture_output=True)

  def test_sync_adds_moves_and_tombstones(self):
    store.sync_route_manifest(self.conn, self.uid, self.manifest("R/a", "R/b"))
    head = store.head_rev(self.conn, self.uid)
    self.assertEqual(store.sync_route_manifest(self.conn, self.uid, self.manifest("R/a", "R/b")), 0)
    self.assertEqual(store.head_rev(self.conn, self.uid), head)
    store.sync_route_manifest(self.conn, self.uid, self.manifest("R/a", "R/c"))
    feed = store.changes_since(self.conn, self.uid, head, 100, self.epoch())
    got = {(c["id"], c["deleted"]) for c in feed["changes"]}
    self.assertEqual(got, {("R/b", True), ("R/c", False)})

  def test_metadata_is_overlaid_not_stored_in_the_route_row(self):
    store.put_item(self.conn, self.uid, "metadata", "R/a", {"rating": 5})
    store.sync_route_manifest(self.conn, self.uid, {"regions": [{"name": "R", "routes": [
      {"key": "R/a", "name": "a", "rating": 1}]}]})
    self.assertNotIn("rating", store.get_item(self.conn, self.uid, "route", "R/a"))
    self.assertEqual(store.routes_manifest(self.conn, self.uid)["regions"][0]["routes"][0]["rating"], 5)

  def test_unreadable_manifest_keeps_rows(self):
    store.sync_route_manifest(self.conn, self.uid, self.manifest("R/a"))
    bad = self.udir / "routes.json"
    bad.write_text("{half", encoding="utf-8")
    store.ingest_route_manifest(self.conn, self.uid, bad)
    self.assertEqual(store.count_items(self.conn, self.uid, "route"), 1)
    bad.unlink()
    store.ingest_route_manifest(self.conn, self.uid, bad)
    self.assertEqual(store.count_items(self.conn, self.uid, "route"), 0)


class TestTransaction(StoreCase):
  def test_rollback_on_error(self):
    with self.assertRaises(RuntimeError):
      with store.transaction(self.conn):
        store.put_item(self.conn, self.uid, "pref", "k", 1)
        raise RuntimeError("boom")
    self.assertEqual(store.count_items(self.conn, self.uid, "pref"), 0)
    self.assertEqual(store.head_rev(self.conn, self.uid), 0)


class TestExportFiles(StoreCase):
  def test_round_trip_through_replace(self):
    store.replace_list(self.conn, self.uid, "place", [{"name": "A", "lat": 1, "lon": 2}, {"name": "B", "lat": 3, "lon": 4}])
    store.replace_map(self.conn, self.uid, "metadata", {"R/t": {"rating": 3}})
    files = store.export_files(self.conn, self.uid)
    self.assertIn("places.json", files)
    self.assertNotIn("areas.json", files)
    places = json.loads(files["places.json"])
    self.assertEqual([p["name"] for p in places], ["A", "B"])
    other = create_user(self.conn, "amy", "correct-horse-battery")
    store.replace_list(self.conn, other, "place", places)
    store.replace_map(self.conn, other, "metadata", json.loads(files["metadata.json"]))
    self.assertEqual(store.export_files(self.conn, other), files)


class TestImportReplace(StoreCase):
  def setUp(self):
    super().setUp()
    (self.udir / "gpx" / "R").mkdir(parents=True)
    (self.udir / "gpx" / "R" / "old.gpx").write_bytes(b"old")
    store.replace_list(self.conn, self.uid, "place", [{"name": "Kept", "lat": 1, "lon": 2}])
    self.payload = ImportPayload(
      places=[{"name": "New", "lat": 3, "lon": 4}], gpx={"gpx/R/new.gpx": b"new"})

  def assert_untouched(self):
    self.assertEqual([p["name"] for p in store.list_items(self.conn, self.uid, "place")], ["Kept"])
    self.assertEqual(sorted(p.name for p in (self.udir / "gpx" / "R").iterdir()), ["old.gpx"])
    self.assertEqual([p.name for p in self.udir.iterdir()], ["gpx"])

  def test_replaces_rows_and_tracks(self):
    import_replace(self.conn, self.uid, self.udir, self.payload)
    self.assertEqual([p["name"] for p in store.list_items(self.conn, self.uid, "place")], ["New"])
    self.assertEqual(sorted(p.name for p in (self.udir / "gpx" / "R").iterdir()), ["new.gpx"])
    self.assertEqual([p.name for p in self.udir.iterdir()], ["gpx"])

  def test_row_failure_leaves_rows_and_tracks(self):
    with mock.patch.object(store, "sync_route_manifest", side_effect=sqlite3.OperationalError("boom")):
      with self.assertRaises(sqlite3.Error):
        import_replace(self.conn, self.uid, self.udir, self.payload)
    self.assert_untouched()

  def test_staging_failure_leaves_rows_and_tracks(self):
    with mock.patch("ferd_api.transfer._write_import_gpx", side_effect=OSError("disk full")):
      with self.assertRaises(OSError):
        import_replace(self.conn, self.uid, self.udir, self.payload)
    self.assert_untouched()

  def test_swap_failure_restores_the_old_tree(self):
    real = os.rename
    calls = []

    def flaky(src, dst):
      calls.append(src)
      if len(calls) == 2:
        raise OSError("rename failed")
      return real(src, dst)

    with mock.patch("ferd_api.transfer.os.rename", side_effect=flaky):
      with self.assertRaises(OSError):
        import_replace(self.conn, self.uid, self.udir, self.payload)
    self.assert_untouched()

  def test_tracks_are_staged_before_the_transaction(self):
    seen = []
    real = store.replace_list

    def spy(*a, **k):
      seen.append(sorted(p.name for p in self.udir.iterdir() if p.name.startswith(".import-")))
      return real(*a, **k)

    with mock.patch.object(store, "replace_list", side_effect=spy):
      import_replace(self.conn, self.uid, self.udir, self.payload)
    self.assertEqual(len(seen[0]), 1)  # tracks were already staged when the transaction began


if __name__ == "__main__":
  unittest.main()
