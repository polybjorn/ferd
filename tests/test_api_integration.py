"""Integration tests for tools/api.py.

Spins up a fresh atlas API server in a subprocess against a tempdir
data dir + sqlite db, then exercises endpoints via urllib.

Run with: python3 -m unittest discover -s tests
"""

from __future__ import annotations

import io
import json
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from http.cookiejar import CookieJar
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
API_SCRIPT = REPO_ROOT / "tools" / "api.py"

SEED_USER = "admin"
SEED_PW = "test-password-1234"


def _free_port() -> int:
  with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    return s.getsockname()[1]


class _Server:
  """A subprocess-backed atlas API server with its own tempdir + sqlite."""

  def __init__(self) -> None:
    self.tmp = tempfile.TemporaryDirectory()
    self.data_dir = Path(self.tmp.name)
    self.port = _free_port()
    self.base_url = f"http://127.0.0.1:{self.port}"
    cfg = {
      "bind": f"127.0.0.1:{self.port}",
      "db_path": str(self.data_dir / "test.db"),
      "data_dir": str(self.data_dir),
      "static_dir": str(self.data_dir),
      "manifest_cmd": "",  # disable manifest regen during tests
      "initial_user": SEED_USER,
      "initial_password": SEED_PW,
      "secure_cookies": False,
      "max_body_bytes": 1048576,
    }
    cfg_path = self.data_dir / "config.json"
    cfg_path.write_text(json.dumps(cfg))
    self.proc = subprocess.Popen(
      [sys.executable, str(API_SCRIPT), "--config", str(cfg_path)],
      stdout=subprocess.DEVNULL,
      stderr=subprocess.DEVNULL,
    )
    self._wait_ready()

  def _wait_ready(self, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
      if self.proc.poll() is not None:
        raise RuntimeError(f"server exited early (code {self.proc.returncode})")
      try:
        with urllib.request.urlopen(self.base_url + "/api/state", timeout=0.5) as r:
          if r.status == 200:
            return
      except Exception:
        time.sleep(0.05)
    raise RuntimeError("server did not respond on /api/state within timeout")

  def close(self) -> None:
    if self.proc.poll() is None:
      self.proc.terminate()
      try:
        self.proc.wait(timeout=3)
      except subprocess.TimeoutExpired:
        self.proc.kill()
        self.proc.wait()
    self.tmp.cleanup()


_server: _Server | None = None


def setUpModule() -> None:
  global _server
  _server = _Server()


def tearDownModule() -> None:
  if _server is not None:
    _server.close()


class Client:
  """Tiny JSON+cookie client tied to a single atlas server."""

  def __init__(self, base_url: str) -> None:
    self.base_url = base_url
    self.opener = urllib.request.build_opener(
      urllib.request.HTTPCookieProcessor(CookieJar())
    )

  def request(self, method: str, path: str, body=None, *, raw_body: bytes | None = None, content_type: str | None = None):
    url = self.base_url + path
    headers: dict[str, str] = {}
    data: bytes | None = None
    if raw_body is not None:
      data = raw_body
      if content_type:
        headers["Content-Type"] = content_type
    elif body is not None:
      data = json.dumps(body).encode("utf-8")
      headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
      with self.opener.open(req) as r:
        payload = r.read()
        return r.status, (json.loads(payload) if payload else None)
    except urllib.error.HTTPError as e:
      payload = e.read()
      try:
        body = json.loads(payload) if payload else None
      except json.JSONDecodeError:
        body = payload.decode("utf-8", "replace")
      return e.code, body

  def login(self, username: str, password: str):
    return self.request("POST", "/api/login", {"username": username, "password": password})


def admin_client() -> Client:
  c = Client(_server.base_url)  # type: ignore[union-attr]
  status, _ = c.login(SEED_USER, SEED_PW)
  assert status == 200, f"admin login failed: {status}"
  return c


def admin_dir() -> Path:
  """Per-user data dir for the seeded admin."""
  return _server.data_dir / "users" / SEED_USER  # type: ignore[union-attr]


def fresh_places(items: list | None = None) -> None:
  """Replace the admin's places.json on disk so tests can assume a known state."""
  d = admin_dir()
  d.mkdir(parents=True, exist_ok=True)
  (d / "places.json").write_text(
    json.dumps(items or [], ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
  )


# ---------- tests ----------


class TestState(unittest.TestCase):
  def test_anonymous_state(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, body = c.request("GET", "/api/state")
    self.assertEqual(status, 200)
    self.assertFalse(body["authenticated"])
    self.assertFalse(body["is_admin"])


class TestAuth(unittest.TestCase):
  def test_login_wrong_password(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.login(SEED_USER, "nope")
    self.assertEqual(status, 401)

  def test_login_unknown_user(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.login("nobody", SEED_PW)
    self.assertEqual(status, 401)

  def test_login_then_state(self):
    c = admin_client()
    status, body = c.request("GET", "/api/state")
    self.assertEqual(status, 200)
    self.assertTrue(body["authenticated"])
    self.assertTrue(body["is_admin"])
    self.assertEqual(body["username"], SEED_USER)

  def test_logout(self):
    c = admin_client()
    status, _ = c.request("POST", "/api/logout")
    self.assertEqual(status, 200)
    status, body = c.request("GET", "/api/state")
    self.assertFalse(body["authenticated"])

  def test_change_password_then_revert(self):
    c = admin_client()
    new_pw = "new-password-9999"
    status, _ = c.request("POST", "/api/change-password",
                          {"current_password": SEED_PW, "new_password": new_pw})
    self.assertEqual(status, 200)
    # Revert so other tests still work.
    c2 = Client(_server.base_url)  # type: ignore[union-attr]
    self.assertEqual(c2.login(SEED_USER, new_pw)[0], 200)
    self.assertEqual(c2.request("POST", "/api/change-password",
                                {"current_password": new_pw, "new_password": SEED_PW})[0], 200)

  def test_change_password_wrong_current(self):
    c = admin_client()
    status, _ = c.request("POST", "/api/change-password",
                          {"current_password": "wrong", "new_password": "also-long-enough-pw"})
    self.assertEqual(status, 401)


class TestRegistrationGate(unittest.TestCase):
  def test_registration_closed_by_default_after_seed(self):
    # Seed counts as user 1, so register endpoint should reject.
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request("POST", "/api/register",
                          {"username": "bob", "password": "bob-password-123"})
    self.assertEqual(status, 403)


class TestPlacesAuthGates(unittest.TestCase):
  PAYLOAD = {"name": "AuthGateTest", "lat": 0, "lon": 0, "category": "test"}

  def test_anon_create_blocked(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request("POST", "/api/places", self.PAYLOAD)
    self.assertEqual(status, 401)

  def test_anon_update_blocked(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request("PUT", "/api/places",
                          {"original_name": "x", "place": self.PAYLOAD})
    self.assertEqual(status, 401)

  def test_anon_delete_blocked(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request("DELETE", "/api/places", {"name": "x"})
    self.assertEqual(status, 401)


class TestPlacesCRUD(unittest.TestCase):
  def setUp(self):
    self.c = admin_client()
    fresh_places([])

  def test_create_lists_and_persists(self):
    status, body = self.c.request("POST", "/api/places",
                                  {"name": "P1", "lat": 1, "lon": 2, "category": "cat"})
    self.assertEqual(status, 201)
    self.assertTrue(body["ok"])
    self.assertEqual(body["total_places"], 1)
    on_disk = json.loads((admin_dir() / "places.json").read_text())
    self.assertEqual(len(on_disk), 1)
    self.assertEqual(on_disk[0]["name"], "P1")

  def test_create_validation_error(self):
    status, body = self.c.request("POST", "/api/places",
                                  {"name": "X", "lat": 200, "lon": 0, "category": "cat"})
    self.assertEqual(status, 400)
    self.assertIn("lat", body["error"])

  def test_update_rename(self):
    self.c.request("POST", "/api/places",
                   {"name": "Old", "lat": 0, "lon": 0, "category": "cat"})
    status, _ = self.c.request("PUT", "/api/places",
                               {"original_name": "Old",
                                "place": {"name": "New", "lat": 0, "lon": 0, "category": "cat"}})
    self.assertEqual(status, 200)
    on_disk = json.loads((admin_dir() / "places.json").read_text())
    self.assertEqual(on_disk[0]["name"], "New")

  def test_update_collision(self):
    for name in ("A", "B"):
      self.c.request("POST", "/api/places",
                     {"name": name, "lat": 0, "lon": 0, "category": "cat"})
    # Renaming A to B should fail.
    status, body = self.c.request("PUT", "/api/places",
                                  {"original_name": "A",
                                   "place": {"name": "B", "lat": 0, "lon": 0, "category": "cat"}})
    self.assertEqual(status, 409)
    self.assertIn("already uses", body["error"])

  def test_update_not_found(self):
    status, _ = self.c.request("PUT", "/api/places",
                               {"original_name": "ghost",
                                "place": {"name": "ghost", "lat": 0, "lon": 0, "category": "cat"}})
    self.assertEqual(status, 404)

  def test_delete(self):
    self.c.request("POST", "/api/places",
                   {"name": "ToGo", "lat": 0, "lon": 0, "category": "cat"})
    status, body = self.c.request("DELETE", "/api/places", {"name": "ToGo"})
    self.assertEqual(status, 200)
    self.assertEqual(body["total_places"], 0)

  def test_delete_not_found(self):
    status, _ = self.c.request("DELETE", "/api/places", {"name": "never-was"})
    self.assertEqual(status, 404)


class TestSiteConfig(unittest.TestCase):
  def test_category_labels_anon_blocked(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request("PUT", "/api/site-config/category-labels",
                          {"category_labels": {"food": "Food"}})
    self.assertEqual(status, 401)

  def test_category_labels_update(self):
    c = admin_client()
    status, body = c.request("PUT", "/api/site-config/category-labels",
                             {"category_labels": {"food": "Food", "hike": "Hiking"}})
    self.assertEqual(status, 200)
    self.assertEqual(body["category_labels"], {"food": "Food", "hike": "Hiking"})
    on_disk = json.loads((_server.data_dir / "site-config.json").read_text())  # type: ignore[union-attr]
    self.assertEqual(on_disk["category_labels"]["food"], "Food")

  def test_category_labels_validation(self):
    c = admin_client()
    # Non-dict payload.
    status, _ = c.request("PUT", "/api/site-config/category-labels",
                          {"category_labels": "not a dict"})
    self.assertEqual(status, 400)


GPX_BODY = (
  b'<?xml version="1.0" encoding="UTF-8"?>'
  b'<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Test">'
  b'<trk><name>Trail</name><trkseg>'
  b'<trkpt lat="60.0" lon="5.0"><time>2024-01-01T00:00:00Z</time><ele>10</ele></trkpt>'
  b'<trkpt lat="60.1" lon="5.1"><ele>20</ele></trkpt>'
  b'</trkseg></trk></gpx>'
)


class TestGpx(unittest.TestCase):
  def test_anon_upload_blocked(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request("POST", "/api/gpx?region=R&name=t",
                          raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.assertEqual(status, 401)

  def test_upload_strips_pii_and_deletes(self):
    c = admin_client()
    status, _ = c.request("POST", "/api/gpx?region=TestRegion&name=trail-a",
                          raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.assertEqual(status, 201)
    on_disk = (admin_dir() / "gpx" / "TestRegion" / "trail-a.gpx").read_bytes()
    self.assertNotIn(b"<time>", on_disk)
    self.assertNotIn(b"creator=", on_disk)
    self.assertIn(b"<trk", on_disk)
    # Delete it.
    status, body = c.request("DELETE", "/api/gpx",
                             {"region": "TestRegion", "name": "trail-a"})
    self.assertEqual(status, 200)
    self.assertIn("trail-a.gpx", body["removed"])

  def test_upload_rejects_non_gpx(self):
    c = admin_client()
    status, _ = c.request("POST", "/api/gpx?region=R&name=bad",
                          raw_body=b"<kml/>", content_type="application/gpx+xml")
    self.assertEqual(status, 400)

  def test_delete_missing(self):
    c = admin_client()
    status, _ = c.request("DELETE", "/api/gpx",
                          {"region": "Nowhere", "name": "ghost"})
    self.assertEqual(status, 404)


class TestTrailMetadata(unittest.TestCase):
  KEY = "Region/Trail"

  def setUp(self):
    self.c = admin_client()
    # Clear any prior state from a previous test in this same session.
    meta_path = admin_dir() / "metadata.json"
    if meta_path.exists():
      meta_path.unlink()

  def _put(self, metadata):
    return self.c.request("PUT", "/api/metadata", {"key": self.KEY, "metadata": metadata})

  def test_anon_blocked(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request("PUT", "/api/metadata", {"key": self.KEY, "metadata": {"rating": 4}})
    self.assertEqual(status, 401)

  def test_full_roundtrip(self):
    payload = {
      "source": "https://example.com/x",
      "date_hiked": "2024-08-15",
      "rating": 4,
      "notes": "Loved it. Stunning views.",
      "tags": ["summit", "panorama"],
      "difficulty": "moderate",
    }
    status, body = self._put(payload)
    self.assertEqual(status, 200)
    self.assertEqual(body["metadata"], payload)
    status, all_meta = self.c.request("GET", "/api/metadata")
    self.assertEqual(status, 200)
    self.assertEqual(all_meta[self.KEY], payload)

  def test_empty_metadata_deletes_key(self):
    self._put({"rating": 3})
    status, body = self._put({})
    self.assertEqual(status, 200)
    self.assertEqual(body["metadata"], {})
    status, all_meta = self.c.request("GET", "/api/metadata")
    self.assertNotIn(self.KEY, all_meta)

  def test_bad_source_scheme(self):
    status, body = self._put({"source": "javascript:alert(1)"})
    self.assertEqual(status, 400)
    self.assertIn("http", body["error"])

  def test_bad_rating(self):
    self.assertEqual(self._put({"rating": 0})[0], 400)
    self.assertEqual(self._put({"rating": 9})[0], 400)
    self.assertEqual(self._put({"rating": "five"})[0], 400)

  def test_bad_date(self):
    status, _ = self._put({"date_hiked": "yesterday"})
    self.assertEqual(status, 400)

  def test_bad_difficulty(self):
    status, _ = self._put({"difficulty": "brutal"})
    self.assertEqual(status, 400)

  def test_bad_tags(self):
    self.assertEqual(self._put({"tags": ["Has Space"]})[0], 400)
    self.assertEqual(self._put({"tags": ["a" * 33]})[0], 400)
    self.assertEqual(self._put({"tags": [f"tag{i}" for i in range(11)]})[0], 400)

  def test_unknown_field_rejected(self):
    status, body = self._put({"weather": "sunny"})
    self.assertEqual(status, 400)
    self.assertIn("unknown", body["error"])

  def test_bad_key_shape(self):
    status, _ = self.c.request("PUT", "/api/metadata", {"key": "no-slash", "metadata": {"rating": 3}})
    self.assertEqual(status, 400)


class TestPerUserIsolation(unittest.TestCase):
  """Two authenticated users get separate folders + separate data."""

  def setUp(self):
    self.c = admin_client()
    # Open registration via the admin endpoint, register a second user, close it back up.
    self.c.request("POST", "/api/settings/registration", {"mode": "open"})
    self.peer = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = self.peer.request("POST", "/api/register",
                                  {"username": "peer", "password": "peer-password-1234"})
    assert status in (200, 201, 409), f"unexpected register status: {status}"
    if status == 409:
      # Pre-existing peer from a prior test; just log in.
      assert self.peer.login("peer", "peer-password-1234")[0] == 200
    self.c.request("POST", "/api/settings/registration", {"mode": "closed"})

  def test_places_isolated(self):
    fresh_places([])
    # Admin adds a place; peer should not see it.
    self.c.request("POST", "/api/places",
                   {"name": "AdminOnly", "lat": 1, "lon": 2, "category": "x"})
    status, admin_places = self.c.request("GET", "/api/places")
    self.assertEqual(status, 200)
    self.assertTrue(any(p["name"] == "AdminOnly" for p in admin_places))
    status, peer_places = self.peer.request("GET", "/api/places")
    self.assertEqual(status, 200)
    self.assertFalse(any(p.get("name") == "AdminOnly" for p in peer_places))

  def test_public_blocked_when_unpublished(self):
    # No publish => admin's data is not reachable through /api/u/<user>/.
    self.c.request("POST", "/api/me/publish", {"published": False})
    c_anon = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c_anon.request("GET", "/api/u/admin/places")
    self.assertEqual(status, 404)

  def test_public_allowed_when_published(self):
    fresh_places([{"name": "Pub", "lat": 0, "lon": 0, "category": "x"}])
    self.c.request("POST", "/api/me/publish", {"published": True})
    try:
      c_anon = Client(_server.base_url)  # type: ignore[union-attr]
      status, body = c_anon.request("GET", "/api/u/admin/places")
      self.assertEqual(status, 200)
      self.assertTrue(any(p["name"] == "Pub" for p in body))
    finally:
      self.c.request("POST", "/api/me/publish", {"published": False})


class TestPrefs(unittest.TestCase):
  def test_prefs_roundtrip(self):
    c = admin_client()
    payload = {"theme": "nord", "marker_size": "large"}
    status, _ = c.request("PUT", "/api/me/prefs", payload)
    self.assertEqual(status, 200)
    status, body = c.request("GET", "/api/me/prefs")
    self.assertEqual(status, 200)
    self.assertEqual(body, payload)


class TestExport(unittest.TestCase):
  def test_export_returns_zip(self):
    c = admin_client()
    fresh_places([{"name": "Inside", "lat": 0, "lon": 0, "category": "x"}])
    url = _server.base_url + "/api/me/export"  # type: ignore[union-attr]
    req = urllib.request.Request(url)
    # Reuse the client's cookie jar so we're authenticated.
    with c.opener.open(req) as r:
      self.assertEqual(r.status, 200)
      self.assertEqual(r.headers.get("Content-Type"), "application/zip")
      payload = r.read()
    # ZIP magic bytes.
    self.assertEqual(payload[:2], b"PK")


class TestSessionsRevokeOthers(unittest.TestCase):
  def test_revoke_others_keeps_current(self):
    c1 = admin_client()
    c2 = admin_client()
    status, body = c1.request("GET", "/api/sessions")
    self.assertEqual(status, 200)
    self.assertGreaterEqual(len(body["sessions"]), 2)
    status, body = c1.request("POST", "/api/sessions/revoke-others")
    self.assertEqual(status, 200)
    self.assertGreaterEqual(body["removed"], 1)
    status, body = c1.request("GET", "/api/sessions")
    self.assertEqual(status, 200)
    self.assertEqual(len(body["sessions"]), 1)
    self.assertTrue(body["sessions"][0]["current"])
    status, _ = c2.request("GET", "/api/state")
    self.assertEqual(status, 200)


class TestImport(unittest.TestCase):
  def _make_zip(self, files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
      for name, data in files.items():
        zf.writestr(name, data)
    return buf.getvalue()

  def _post_zip(self, c: Client, mode: str, payload: bytes):
    return c.request("POST", f"/api/me/import?mode={mode}",
                     raw_body=payload, content_type="application/zip")

  def _gpx_bytes(self, name: str) -> bytes:
    return (
      f'<?xml version="1.0" encoding="UTF-8"?>'
      f'<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">'
      f'<trk><name>{name}</name><trkseg>'
      f'<trkpt lat="0" lon="0"><ele>1</ele></trkpt>'
      f'<trkpt lat="0.001" lon="0.001"><ele>2</ele></trkpt>'
      f'</trkseg></trk></gpx>'
    ).encode("utf-8")

  def setUp(self):
    self.c = admin_client()
    fresh_places([])

  def test_replace_mode_overwrites_places(self):
    fresh_places([{"name": "Existing", "lat": 1, "lon": 2, "category": "old"}])
    zip_payload = self._make_zip({
      "places.json": json.dumps([
        {"name": "Fresh1", "lat": 10, "lon": 20, "category": "new"},
        {"name": "Fresh2", "lat": 11, "lon": 21, "category": "new"},
      ]).encode("utf-8"),
    })
    status, body = self._post_zip(self.c, "replace", zip_payload)
    self.assertEqual(status, 200, body)
    self.assertEqual(body["imported"]["places"], 2)
    status, listing = self.c.request("GET", "/api/places")
    self.assertEqual(status, 200)
    names = sorted(p["name"] for p in listing)
    self.assertEqual(names, ["Fresh1", "Fresh2"])

  def test_merge_mode_dedupes_by_name(self):
    fresh_places([{"name": "Keep", "lat": 1, "lon": 2, "category": "old"}])
    zip_payload = self._make_zip({
      "places.json": json.dumps([
        {"name": "Keep", "lat": 50, "lon": 50, "category": "ignored"},
        {"name": "Add", "lat": 5, "lon": 6, "category": "new"},
      ]).encode("utf-8"),
    })
    status, body = self._post_zip(self.c, "merge", zip_payload)
    self.assertEqual(status, 200, body)
    self.assertEqual(body["imported"]["places"], 1)
    status, listing = self.c.request("GET", "/api/places")
    self.assertEqual(status, 200)
    names = sorted(p["name"] for p in listing)
    self.assertEqual(names, ["Add", "Keep"])

  def test_rejects_path_traversal(self):
    zip_payload = self._make_zip({"../escape.json": b"{}"})
    status, body = self._post_zip(self.c, "replace", zip_payload)
    self.assertEqual(status, 400, body)

  def test_rejects_unexpected_file(self):
    zip_payload = self._make_zip({"random.bin": b"\x00\x01"})
    status, body = self._post_zip(self.c, "replace", zip_payload)
    self.assertEqual(status, 400, body)

  def test_rejects_invalid_place(self):
    zip_payload = self._make_zip({
      "places.json": json.dumps([{"name": "BadLat", "lat": 999, "lon": 0, "category": "x"}]).encode("utf-8"),
    })
    status, body = self._post_zip(self.c, "replace", zip_payload)
    self.assertEqual(status, 400, body)

  def test_rejects_bad_mode(self):
    zip_payload = self._make_zip({"places.json": b"[]"})
    status, body = self._post_zip(self.c, "wipe", zip_payload)
    self.assertEqual(status, 400, body)

  def test_anon_blocked(self):
    anon = Client(_server.base_url)  # type: ignore[union-attr]
    zip_payload = self._make_zip({"places.json": b"[]"})
    status, _ = self._post_zip(anon, "replace", zip_payload)
    self.assertEqual(status, 401)

  def test_gpx_roundtrip(self):
    arc = "gpx/regionA/trail1.gpx"
    zip_payload = self._make_zip({
      "places.json": b"[]",
      arc: self._gpx_bytes("trail1"),
    })
    status, body = self._post_zip(self.c, "replace", zip_payload)
    self.assertEqual(status, 200, body)
    self.assertEqual(body["imported"]["gpx"], 1)
    self.assertTrue((admin_dir() / arc).exists())


if __name__ == "__main__":
  unittest.main()
