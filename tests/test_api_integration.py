"""Integration tests for tools/api.py.

Spins up a fresh API server in a subprocess against a tempdir
data dir + sqlite db, then exercises endpoints via urllib.

Run with: python3 -m unittest discover -s tests
"""

from __future__ import annotations

import io
import json
import shutil
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
  """A subprocess-backed API server with its own tempdir + sqlite."""

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
  """Tiny JSON+cookie client tied to a single API server."""

  def __init__(self, base_url: str) -> None:
    self.base_url = base_url
    self.opener = urllib.request.build_opener(
      urllib.request.HTTPCookieProcessor(CookieJar())
    )

  def request(self, method: str, path: str, body=None, *, raw_body: bytes | None = None, content_type: str | None = None, headers: dict[str, str] | None = None):
    url = self.base_url + path
    headers = dict(headers or {})
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
                          {"id": "0" * 8, "place": self.PAYLOAD})
    self.assertEqual(status, 401)

  def test_anon_delete_blocked(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request("DELETE", "/api/places", {"id": "0" * 8})
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
    _, created = self.c.request("POST", "/api/places",
                                {"name": "Old", "lat": 0, "lon": 0, "category": "cat"})
    pid = created["place"]["id"]
    status, _ = self.c.request("PUT", "/api/places",
                               {"id": pid,
                                "place": {"name": "New", "lat": 0, "lon": 0, "category": "cat"}})
    self.assertEqual(status, 200)
    on_disk = json.loads((admin_dir() / "places.json").read_text())
    self.assertEqual(on_disk[0]["name"], "New")
    self.assertEqual(on_disk[0]["id"], pid)

  def test_update_same_name_targets_correct_row(self):
    # Two rows with the same name are allowed; update by id hits the right one.
    _, a = self.c.request("POST", "/api/places",
                          {"name": "Dup", "lat": 1, "lon": 1, "category": "cat"})
    _, b = self.c.request("POST", "/api/places",
                          {"name": "Dup", "lat": 2, "lon": 2, "category": "cat"})
    status, _ = self.c.request("PUT", "/api/places",
                               {"id": b["place"]["id"],
                                "place": {"name": "Dup", "lat": 9, "lon": 9, "category": "cat"}})
    self.assertEqual(status, 200)
    on_disk = json.loads((admin_dir() / "places.json").read_text())
    by_id = {p["id"]: p for p in on_disk}
    self.assertEqual(by_id[a["place"]["id"]]["lat"], 1)
    self.assertEqual(by_id[b["place"]["id"]]["lat"], 9)

  def test_update_not_found(self):
    status, _ = self.c.request("PUT", "/api/places",
                               {"id": "0" * 8,
                                "place": {"name": "ghost", "lat": 0, "lon": 0, "category": "cat"}})
    self.assertEqual(status, 404)

  def test_delete(self):
    _, created = self.c.request("POST", "/api/places",
                                {"name": "ToGo", "lat": 0, "lon": 0, "category": "cat"})
    status, body = self.c.request("DELETE", "/api/places", {"id": created["place"]["id"]})
    self.assertEqual(status, 200)
    self.assertEqual(body["total_places"], 0)

  def test_delete_same_name_removes_only_targeted_row(self):
    _, a = self.c.request("POST", "/api/places",
                          {"name": "Twin", "lat": 1, "lon": 1, "category": "cat"})
    _, b = self.c.request("POST", "/api/places",
                          {"name": "Twin", "lat": 2, "lon": 2, "category": "cat"})
    status, body = self.c.request("DELETE", "/api/places", {"id": a["place"]["id"]})
    self.assertEqual(status, 200)
    self.assertEqual(body["total_places"], 1)
    on_disk = json.loads((admin_dir() / "places.json").read_text())
    self.assertEqual(on_disk[0]["id"], b["place"]["id"])

  def test_delete_not_found(self):
    status, _ = self.c.request("DELETE", "/api/places", {"id": "0" * 8})
    self.assertEqual(status, 404)


  def test_create_without_category(self):
    status, _ = self.c.request("POST", "/api/places",
                               {"name": "NoCat", "lat": 0, "lon": 0})
    self.assertEqual(status, 201)
    on_disk = json.loads((admin_dir() / "places.json").read_text())
    self.assertEqual(on_disk[0]["name"], "NoCat")
    self.assertNotIn("category", on_disk[0])

  def test_create_with_empty_category_strips_field(self):
    status, _ = self.c.request("POST", "/api/places",
                               {"name": "Blank", "lat": 0, "lon": 0, "category": ""})
    self.assertEqual(status, 201)
    on_disk = json.loads((admin_dir() / "places.json").read_text())
    self.assertNotIn("category", on_disk[0])

  def test_clear_category_bulk(self):
    for name in ("A", "B", "C"):
      self.c.request("POST", "/api/places",
                     {"name": name, "lat": 0, "lon": 0, "category": "beach"})
    self.c.request("POST", "/api/places",
                   {"name": "Keep", "lat": 0, "lon": 0, "category": "castle"})
    status, body = self.c.request("POST", "/api/places/clear-category",
                                  {"category": "beach"})
    self.assertEqual(status, 200)
    self.assertEqual(body["cleared"], 3)
    on_disk = json.loads((admin_dir() / "places.json").read_text())
    by_name = {p["name"]: p for p in on_disk}
    self.assertNotIn("category", by_name["A"])
    self.assertNotIn("category", by_name["B"])
    self.assertNotIn("category", by_name["C"])
    self.assertEqual(by_name["Keep"]["category"], "castle")

  def test_clear_category_missing_arg(self):
    status, _ = self.c.request("POST", "/api/places/clear-category", {})
    self.assertEqual(status, 400)


class TestCategoryLabels(unittest.TestCase):
  def test_anon_blocked(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request("PUT", "/api/me/category-labels",
                          {"category_labels": {"food": "Food"}})
    self.assertEqual(status, 401)
    status, _ = c.request("GET", "/api/me/category-labels")
    self.assertEqual(status, 401)

  def test_update_and_read(self):
    c = admin_client()
    status, body = c.request("PUT", "/api/me/category-labels",
                             {"category_labels": {
                               "food": {"label": "Food"},
                               "hike": {"label": "Hiking"},
                             }})
    self.assertEqual(status, 200)
    self.assertEqual(body["category_labels"],
                     {"food": {"label": "Food"}, "hike": {"label": "Hiking"}})
    on_disk = json.loads((admin_dir() / "category-labels.json").read_text())
    self.assertEqual(on_disk["food"], {"label": "Food"})
    status, body = c.request("GET", "/api/me/category-labels")
    self.assertEqual(status, 200)
    self.assertEqual(body["category_labels"]["hike"], {"label": "Hiking"})

  def test_color_round_trips(self):
    c = admin_client()
    payload = {
      "food": {"label": "Food", "color": 3},
      "hike": {"label": "Hiking", "color": 7},
    }
    status, body = c.request("PUT", "/api/me/category-labels",
                             {"category_labels": payload})
    self.assertEqual(status, 200)
    self.assertEqual(body["category_labels"]["food"], {"label": "Food", "color": 3})
    status, body = c.request("GET", "/api/me/category-labels")
    self.assertEqual(body["category_labels"]["hike"], {"label": "Hiking", "color": 7})

  def test_color_preserved_when_caller_omits_it(self):
    c = admin_client()
    # First save with colors.
    c.request("PUT", "/api/me/category-labels",
              {"category_labels": {"food": {"label": "Food", "color": 2}}})
    # Then rewrite without color (e.g. Manage Categories renames the label).
    status, body = c.request("PUT", "/api/me/category-labels",
                             {"category_labels": {"food": {"label": "Cuisine"}}})
    self.assertEqual(status, 200)
    self.assertEqual(body["category_labels"]["food"], {"label": "Cuisine", "color": 2})

  def test_validation(self):
    c = admin_client()
    status, _ = c.request("PUT", "/api/me/category-labels",
                          {"category_labels": "not a dict"})
    self.assertEqual(status, 400)
    # bare string value rejected (must be {label, color?}).
    status, _ = c.request("PUT", "/api/me/category-labels",
                          {"category_labels": {"x": "X"}})
    self.assertEqual(status, 400)
    # color must be an integer.
    status, _ = c.request("PUT", "/api/me/category-labels",
                          {"category_labels": {"x": {"label": "X", "color": "blue"}}})
    self.assertEqual(status, 400)
    # color must be in range.
    status, _ = c.request("PUT", "/api/me/category-labels",
                          {"category_labels": {"x": {"label": "X", "color": -1}}})
    self.assertEqual(status, 400)
    # unknown keys rejected.
    status, _ = c.request("PUT", "/api/me/category-labels",
                          {"category_labels": {"x": {"label": "X", "extra": 1}}})
    self.assertEqual(status, 400)

  def test_public_read_when_published(self):
    c = admin_client()
    c.request("PUT", "/api/me/category-labels",
              {"category_labels": {"beach": {"label": "Beaches", "color": 4}}})
    c.request("POST", "/api/me/publish", {"published": True})
    anon = Client(_server.base_url)  # type: ignore[union-attr]
    try:
      status, body = anon.request("GET", f"/api/u/{SEED_USER}/category-labels")
      self.assertEqual(status, 200)
      self.assertEqual(body["category_labels"]["beach"], {"label": "Beaches", "color": 4})
    finally:
      c.request("POST", "/api/me/publish", {"published": False})

  def test_public_read_blocked_when_unpublished(self):
    anon = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = anon.request("GET", f"/api/u/{SEED_USER}/category-labels")
    self.assertEqual(status, 404)


GPX_BODY = (
  b'<?xml version="1.0" encoding="UTF-8"?>'
  b'<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Test">'
  b'<trk><name>Route</name><trkseg>'
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

  def test_upload_preserves_pii_by_default(self):
    """PII stripping is opt-in; an unflagged upload keeps timestamps/creator."""
    c = admin_client()
    status, _ = c.request("POST", "/api/gpx?region=TestRegion&name=route-a",
                          raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.assertEqual(status, 201)
    on_disk = (admin_dir() / "gpx" / "TestRegion" / "route-a.gpx").read_bytes()
    self.assertIn(b"<time>", on_disk)
    # Delete it.
    status, body = c.request("DELETE", "/api/gpx",
                             {"region": "TestRegion", "name": "route-a"})
    self.assertEqual(status, 200)
    self.assertIn("route-a.gpx", body["removed"])

  def test_upload_strips_pii_when_requested(self):
    c = admin_client()
    status, _ = c.request("POST", "/api/gpx?region=TestRegion&name=route-b&strip_pii=true",
                          raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.assertEqual(status, 201)
    on_disk = (admin_dir() / "gpx" / "TestRegion" / "route-b.gpx").read_bytes()
    self.assertNotIn(b"<time>", on_disk)
    self.assertNotIn(b"creator=", on_disk)
    self.assertIn(b"<trk", on_disk)
    c.request("DELETE", "/api/gpx", {"region": "TestRegion", "name": "route-b"})

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

  def test_upload_serve_delete_without_region(self):
    """Region is optional: GPX can live at gpx/<file>.gpx (root-level)."""
    c = admin_client()
    status, body = c.request("POST", "/api/gpx?name=loose-route",
                             raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.assertEqual(status, 201)
    self.assertEqual(body["saved"], "gpx/loose-route.gpx")
    self.assertTrue((admin_dir() / "gpx" / "loose-route.gpx").exists())
    # Serve via single-segment URL (binary body, so skip the JSON client).
    req = urllib.request.Request(_server.base_url + "/api/gpx/loose-route.gpx")  # type: ignore[union-attr]
    with c.opener.open(req) as r:
      self.assertEqual(r.status, 200)
      self.assertIn(b"<trk", r.read())
    # Delete: omit region from the body.
    status, body = c.request("DELETE", "/api/gpx", {"name": "loose-route"})
    self.assertEqual(status, 200)
    self.assertFalse((admin_dir() / "gpx" / "loose-route.gpx").exists())


class TestRegions(unittest.TestCase):
  def setUp(self):
    self.c = admin_client()
    # Clean slate.
    gpx_root = admin_dir() / "gpx"
    if gpx_root.exists():
      shutil.rmtree(gpx_root)

  def test_rename_moves_dir_and_metadata(self):
    # Upload one route under Old, then rename to New.
    self.c.request("POST", "/api/gpx?region=Old&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.c.request("PUT", "/api/metadata",
                   {"key": "Old/t", "metadata": {"rating": 4}})
    status, body = self.c.request("POST", "/api/regions/rename",
                                  {"from": "Old", "to": "New"})
    self.assertEqual(status, 200)
    self.assertEqual(body["routes"], 1)
    self.assertEqual(body["metadata"], 1)
    self.assertFalse((admin_dir() / "gpx" / "Old").exists())
    self.assertTrue((admin_dir() / "gpx" / "New" / "t.gpx").exists())
    meta = json.loads((admin_dir() / "metadata.json").read_text())
    self.assertIn("New/t", meta)
    self.assertNotIn("Old/t", meta)

  def test_rename_to_existing_conflicts(self):
    for r in ("A", "B"):
      self.c.request("POST", f"/api/gpx?region={r}&name=x",
                     raw_body=GPX_BODY, content_type="application/gpx+xml")
    status, _ = self.c.request("POST", "/api/regions/rename", {"from": "A", "to": "B"})
    self.assertEqual(status, 409)

  def test_rename_missing(self):
    status, _ = self.c.request("POST", "/api/regions/rename",
                               {"from": "Nope", "to": "Whatever"})
    self.assertEqual(status, 404)

  def test_delete_empty(self):
    # Upload then delete the route, leaving the dir empty.
    self.c.request("POST", "/api/gpx?region=Solo&name=route",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.c.request("DELETE", "/api/gpx", {"region": "Solo", "name": "route"})
    # Delete-route already prunes the empty dir; recreate it for this test.
    (admin_dir() / "gpx" / "Solo").mkdir(parents=True, exist_ok=True)
    status, _ = self.c.request("POST", "/api/regions/delete", {"name": "Solo"})
    self.assertEqual(status, 200)
    self.assertFalse((admin_dir() / "gpx" / "Solo").exists())

  def test_delete_non_empty_blocked(self):
    self.c.request("POST", "/api/gpx?region=Full&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    status, _ = self.c.request("POST", "/api/regions/delete", {"name": "Full"})
    self.assertEqual(status, 409)

  def test_clear_moves_routes_to_root(self):
    self.c.request("POST", "/api/gpx?region=Drop&name=a",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.c.request("POST", "/api/gpx?region=Drop&name=b",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.c.request("PUT", "/api/metadata",
                   {"key": "Drop/a", "metadata": {"rating": 3}})
    status, body = self.c.request("POST", "/api/regions/clear", {"name": "Drop"})
    self.assertEqual(status, 200)
    self.assertEqual(body["routes"], 2)
    self.assertFalse((admin_dir() / "gpx" / "Drop").exists())
    self.assertTrue((admin_dir() / "gpx" / "a.gpx").exists())
    self.assertTrue((admin_dir() / "gpx" / "b.gpx").exists())
    meta = json.loads((admin_dir() / "metadata.json").read_text())
    self.assertIn("a", meta)
    self.assertNotIn("Drop/a", meta)

  def test_clear_conflict_with_existing_root_file(self):
    # A route "x" exists at root (no region); clearing a region that contains
    # another "x.gpx" must fail rather than silently overwriting.
    self.c.request("POST", "/api/gpx?name=x",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.c.request("POST", "/api/gpx?region=Coll&name=x",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    status, body = self.c.request("POST", "/api/regions/clear", {"name": "Coll"})
    self.assertEqual(status, 409)
    self.assertIn("x.gpx", body["error"])


class TestGpxMove(unittest.TestCase):
  def setUp(self):
    self.c = admin_client()
    gpx_root = admin_dir() / "gpx"
    if gpx_root.exists():
      shutil.rmtree(gpx_root)
    meta_path = admin_dir() / "metadata.json"
    if meta_path.exists():
      meta_path.unlink()

  def test_region_to_region(self):
    self.c.request("POST", "/api/gpx?region=From&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.c.request("PUT", "/api/metadata",
                   {"key": "From/t", "metadata": {"rating": 4}})
    status, body = self.c.request("POST", "/api/gpx/move",
                                  {"key": "From/t", "new_region": "To"})
    self.assertEqual(status, 200)
    self.assertEqual(body["new_key"], "To/t")
    self.assertEqual(body["moved"], 1)
    self.assertFalse((admin_dir() / "gpx" / "From").exists())
    self.assertTrue((admin_dir() / "gpx" / "To" / "t.gpx").exists())
    meta = json.loads((admin_dir() / "metadata.json").read_text())
    self.assertIn("To/t", meta)
    self.assertNotIn("From/t", meta)

  def test_region_to_no_region(self):
    self.c.request("POST", "/api/gpx?region=Solo&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    status, body = self.c.request("POST", "/api/gpx/move",
                                  {"key": "Solo/t", "new_region": ""})
    self.assertEqual(status, 200)
    self.assertEqual(body["new_key"], "t")
    self.assertTrue((admin_dir() / "gpx" / "t.gpx").exists())
    self.assertFalse((admin_dir() / "gpx" / "Solo").exists())

  def test_no_region_to_region(self):
    self.c.request("POST", "/api/gpx?name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    status, body = self.c.request("POST", "/api/gpx/move",
                                  {"key": "t", "new_region": "New"})
    self.assertEqual(status, 200)
    self.assertEqual(body["new_key"], "New/t")
    self.assertTrue((admin_dir() / "gpx" / "New" / "t.gpx").exists())
    self.assertFalse((admin_dir() / "gpx" / "t.gpx").exists())

  def test_same_region_is_noop(self):
    self.c.request("POST", "/api/gpx?region=Same&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    status, body = self.c.request("POST", "/api/gpx/move",
                                  {"key": "Same/t", "new_region": "Same"})
    self.assertEqual(status, 200)
    self.assertEqual(body["moved"], 0)
    self.assertTrue((admin_dir() / "gpx" / "Same" / "t.gpx").exists())

  def test_missing_trail_404(self):
    status, _ = self.c.request("POST", "/api/gpx/move",
                               {"key": "Nope/ghost", "new_region": "Other"})
    self.assertEqual(status, 404)

  def test_collision_at_target_409(self):
    self.c.request("POST", "/api/gpx?region=A&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.c.request("POST", "/api/gpx?region=B&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    status, body = self.c.request("POST", "/api/gpx/move",
                                  {"key": "A/t", "new_region": "B"})
    self.assertEqual(status, 409)
    self.assertIn("t.gpx", body["error"])

  def test_rename_only(self):
    self.c.request("POST", "/api/gpx?region=R&name=Old",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.c.request("PUT", "/api/metadata",
                   {"key": "R/Old", "metadata": {"rating": 5}})
    status, body = self.c.request("POST", "/api/gpx/move",
                                  {"key": "R/Old", "new_region": "R", "new_name": "New"})
    self.assertEqual(status, 200)
    self.assertEqual(body["new_key"], "R/New")
    self.assertTrue((admin_dir() / "gpx" / "R" / "New.gpx").exists())
    self.assertFalse((admin_dir() / "gpx" / "R" / "Old.gpx").exists())
    meta = json.loads((admin_dir() / "metadata.json").read_text())
    self.assertIn("R/New", meta)
    self.assertNotIn("R/Old", meta)

  def test_rename_and_move_combined(self):
    self.c.request("POST", "/api/gpx?region=A&name=Old",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    status, body = self.c.request("POST", "/api/gpx/move",
                                  {"key": "A/Old", "new_region": "B", "new_name": "New"})
    self.assertEqual(status, 200)
    self.assertEqual(body["new_key"], "B/New")
    self.assertTrue((admin_dir() / "gpx" / "B" / "New.gpx").exists())
    self.assertFalse((admin_dir() / "gpx" / "A").exists())

  def test_rename_collision_409(self):
    for n in ("Alpha", "Beta"):
      self.c.request("POST", f"/api/gpx?region=R&name={n}",
                     raw_body=GPX_BODY, content_type="application/gpx+xml")
    status, body = self.c.request("POST", "/api/gpx/move",
                                  {"key": "R/Alpha", "new_region": "R", "new_name": "Beta"})
    self.assertEqual(status, 409)
    self.assertIn("Beta.gpx", body["error"])


class TestGpxSetCompleted(unittest.TestCase):
  def setUp(self):
    self.c = admin_client()
    gpx_root = admin_dir() / "gpx"
    if gpx_root.exists():
      shutil.rmtree(gpx_root)

  def test_mark_planned(self):
    self.c.request("POST", "/api/gpx?region=R&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    status, body = self.c.request("POST", "/api/gpx/set-completed",
                                  {"key": "R/t", "completed": False})
    self.assertEqual(status, 200)
    self.assertTrue(body["changed"])
    self.assertFalse((admin_dir() / "gpx" / "R" / "t.gpx").exists())
    self.assertTrue((admin_dir() / "gpx" / "R" / "t.planned.gpx").exists())

  def test_mark_completed(self):
    # Upload as a normal route then rename to planned to set up the state.
    self.c.request("POST", "/api/gpx?region=R&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.c.request("POST", "/api/gpx/set-completed", {"key": "R/t", "completed": False})
    status, body = self.c.request("POST", "/api/gpx/set-completed",
                                  {"key": "R/t", "completed": True})
    self.assertEqual(status, 200)
    self.assertTrue(body["changed"])
    self.assertTrue((admin_dir() / "gpx" / "R" / "t.gpx").exists())
    self.assertFalse((admin_dir() / "gpx" / "R" / "t.planned.gpx").exists())

  def test_already_completed_noop(self):
    self.c.request("POST", "/api/gpx?region=R&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    status, body = self.c.request("POST", "/api/gpx/set-completed",
                                  {"key": "R/t", "completed": True})
    self.assertEqual(status, 200)
    self.assertFalse(body["changed"])

  def test_missing_trail_404(self):
    status, _ = self.c.request("POST", "/api/gpx/set-completed",
                               {"key": "Nope/ghost", "completed": False})
    self.assertEqual(status, 404)

  def test_collision_when_both_exist_409(self):
    # Walked exists; manually drop a planned sibling so both coexist.
    self.c.request("POST", "/api/gpx?region=R&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    (admin_dir() / "gpx" / "R" / "t.planned.gpx").write_bytes(GPX_BODY)
    status, body = self.c.request("POST", "/api/gpx/set-completed",
                                  {"key": "R/t", "completed": False})
    self.assertEqual(status, 409)
    self.assertIn("planned", body["error"])


class TestTrailMetadata(unittest.TestCase):
  KEY = "Region/Route"

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
      "date_completed": "2024-08-15",
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
    status, _ = self._put({"date_completed": "yesterday"})
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

  def test_root_level_key_accepted(self):
    # No-region routes use a 1-part key (no slash).
    status, _ = self.c.request("PUT", "/api/metadata", {"key": "no-slash", "metadata": {"rating": 3}})
    self.assertEqual(status, 200)

  def test_too_many_parts_rejected(self):
    status, _ = self.c.request("PUT", "/api/metadata",
                               {"key": "a/b/c", "metadata": {"rating": 3}})
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


class TestApiTokens(unittest.TestCase):
  def _mint(self, c: Client, name: str, scope: str = "full", **extra):
    body = {"name": name, "scope": scope, **extra}
    return c.request("POST", "/api/me/tokens", body)

  def _bearer(self, token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}

  def test_mint_validation(self):
    c = admin_client()
    status, _ = self._mint(c, "")
    self.assertEqual(status, 400)
    status, _ = self._mint(c, "bad-scope", scope="write")
    self.assertEqual(status, 400)
    status, _ = self._mint(c, "bad-expiry", expires_in_days=0)
    self.assertEqual(status, 400)
    status, _ = self._mint(c, "bad-expiry2", expires_in_days=99999)
    self.assertEqual(status, 400)

  def test_full_token_authenticates_and_writes(self):
    c = admin_client()
    status, body = self._mint(c, "full-tok", scope="full")
    self.assertEqual(status, 200)
    self.assertEqual(body["scope"], "full")
    token = body["token"]
    # Fresh client, no cookie: proves bearer auth stands alone.
    bc = Client(_server.base_url)
    status, _ = bc.request("GET", "/api/sessions", headers=self._bearer(token))
    self.assertEqual(status, 200)
    # A mutation passes the read-only gate (auth worked, scope is full).
    status, _ = bc.request("POST", "/api/places", {}, headers=self._bearer(token))
    self.assertNotIn(status, (401, 403))

  def test_readonly_token_blocks_mutations(self):
    c = admin_client()
    status, body = self._mint(c, "ro-tok", scope="readonly")
    self.assertEqual(status, 200)
    token = body["token"]
    bc = Client(_server.base_url)
    # Reads allowed.
    status, _ = bc.request("GET", "/api/sessions", headers=self._bearer(token))
    self.assertEqual(status, 200)
    # Every mutation is blocked at the gate, before the handler runs.
    status, body = bc.request("POST", "/api/places", {}, headers=self._bearer(token))
    self.assertEqual(status, 403)
    self.assertEqual(body["error"], "read-only token")

  def test_list_never_leaks_secret(self):
    c = admin_client()
    self._mint(c, "list-tok", scope="readonly")
    status, body = c.request("GET", "/api/me/tokens")
    self.assertEqual(status, 200)
    row = next(t for t in body["tokens"] if t["name"] == "list-tok")
    self.assertEqual(row["scope"], "readonly")
    self.assertNotIn("token", row)
    self.assertNotIn("token_hash", row)
    self.assertEqual(len(row["id"]), 12)

  def test_revoke_invalidates(self):
    c = admin_client()
    status, body = self._mint(c, "doomed", scope="full")
    token = body["token"]
    bc = Client(_server.base_url)
    status, _ = bc.request("GET", "/api/sessions", headers=self._bearer(token))
    self.assertEqual(status, 200)
    # Find its id and revoke.
    _, listing = c.request("GET", "/api/me/tokens")
    tid = next(t["id"] for t in listing["tokens"] if t["name"] == "doomed")
    status, body = c.request("POST", "/api/me/tokens/revoke", {"id": tid})
    self.assertEqual(status, 200)
    self.assertEqual(body["removed"], 1)
    # Now the bearer token no longer authenticates.
    status, _ = bc.request("GET", "/api/sessions", headers=self._bearer(token))
    self.assertEqual(status, 401)

  def test_unknown_bearer_rejected(self):
    bc = Client(_server.base_url)
    status, _ = bc.request("GET", "/api/sessions", headers=self._bearer("not-a-real-token"))
    self.assertEqual(status, 401)


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

  def test_skips_archiver_junk(self):
    # macOS Finder/zip, Windows, and editor backups frequently sneak junk
    # entries into archives. The importer should silently ignore them.
    fresh_places([])
    zip_payload = self._make_zip({
      "__MACOSX/._places.json": b"junk",
      "._places.json": b"junk",
      ".DS_Store": b"junk",
      "Thumbs.db": b"junk",
      "places.json.bak": b"junk",
      "places.json~": b"junk",
      "places.json": json.dumps([
        {"name": "Real", "lat": 1, "lon": 2, "category": "x"},
      ]).encode("utf-8"),
    })
    status, body = self._post_zip(self.c, "replace", zip_payload)
    self.assertEqual(status, 200, body)
    self.assertEqual(body["imported"]["places"], 1)

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


class TestAdmin(unittest.TestCase):
  """Admin endpoints: user list, stats, role/unpublish/revoke/delete, publishing toggle."""

  def setUp(self):
    self.c = admin_client()
    # Open registration so we can create a second user, then close again after.
    self.c.request("POST", "/api/settings/registration", {"mode": "open"})
    self.user_c = Client(_server.base_url)  # type: ignore[union-attr]
    status, body = self.user_c.request("POST", "/api/register",
                                       {"username": "bob", "password": "bob-password-123"})
    if status not in (201, 409):
      self.fail(f"could not register bob: {status} {body}")
    if status == 409:
      # Left over from a previous test in the same run; just log bob in.
      self.user_c.login("bob", "bob-password-123")
    self.c.request("POST", "/api/settings/registration", {"mode": "closed"})

  def tearDown(self):
    # Best-effort cleanup so tests don't leak into each other.
    body = self.c.request("GET", "/api/admin/users")[1] or {}
    for u in (body.get("users") or []):
      if u["username"] != SEED_USER:
        self.c.request("DELETE", f"/api/admin/users/{u['id']}")
    self.c.request("POST", "/api/admin/settings/publishing", {"mode": "open"})

  def _bob_id(self) -> int:
    body = self.c.request("GET", "/api/admin/users")[1]
    for u in body["users"]:
      if u["username"] == "bob":
        return u["id"]
    self.fail("bob not in user list")

  def test_anon_blocked(self):
    anon = Client(_server.base_url)  # type: ignore[union-attr]
    for path in ("/api/admin/users", "/api/admin/stats"):
      status, _ = anon.request("GET", path)
      self.assertEqual(status, 401)

  def test_non_admin_blocked(self):
    for path in ("/api/admin/users", "/api/admin/stats"):
      status, _ = self.user_c.request("GET", path)
      self.assertEqual(status, 403)

  def test_users_list_shape(self):
    status, body = self.c.request("GET", "/api/admin/users")
    self.assertEqual(status, 200)
    names = {u["username"] for u in body["users"]}
    self.assertIn(SEED_USER, names)
    self.assertIn("bob", names)
    bob = next(u for u in body["users"] if u["username"] == "bob")
    for key in ("id", "is_admin", "published", "sessions", "places", "routes"):
      self.assertIn(key, bob)

  def test_stats_shape(self):
    status, body = self.c.request("GET", "/api/admin/stats")
    self.assertEqual(status, 200)
    for key in ("users", "published_users", "places", "routes", "db_bytes", "data_bytes"):
      self.assertIn(key, body)
    self.assertGreaterEqual(body["users"], 2)

  def test_unpublish_user(self):
    # Bob opts in to publishing.
    status, _ = self.user_c.request("POST", "/api/me/publish", {"published": True})
    self.assertEqual(status, 200)
    # Admin force-unpublishes.
    status, _ = self.c.request("POST", f"/api/admin/users/{self._bob_id()}/unpublish")
    self.assertEqual(status, 200)
    status, body = self.user_c.request("GET", "/api/state")
    self.assertFalse(body["published"])

  def test_unpublish_all(self):
    self.user_c.request("POST", "/api/me/publish", {"published": True})
    self.c.request("POST", "/api/me/publish", {"published": True})
    status, body = self.c.request("POST", "/api/admin/unpublish-all")
    self.assertEqual(status, 200)
    self.assertGreaterEqual(body["affected"], 2)
    status, body = self.c.request("GET", "/api/admin/stats")
    self.assertEqual(body["published_users"], 0)

  def test_publishing_closed_blocks_non_admin(self):
    status, _ = self.c.request("POST", "/api/admin/settings/publishing", {"mode": "closed"})
    self.assertEqual(status, 200)
    # Bob is blocked from publishing.
    status, _ = self.user_c.request("POST", "/api/me/publish", {"published": True})
    self.assertEqual(status, 403)
    # Admin can still publish themselves.
    status, _ = self.c.request("POST", "/api/me/publish", {"published": True})
    self.assertEqual(status, 200)

  def test_role_promote_demote(self):
    bob_id = self._bob_id()
    status, _ = self.c.request("POST", f"/api/admin/users/{bob_id}/role", {"is_admin": True})
    self.assertEqual(status, 200)
    # Bob can now hit admin endpoints.
    status, _ = self.user_c.request("GET", "/api/admin/stats")
    self.assertEqual(status, 200)
    # Demote.
    status, _ = self.c.request("POST", f"/api/admin/users/{bob_id}/role", {"is_admin": False})
    self.assertEqual(status, 200)
    status, _ = self.user_c.request("GET", "/api/admin/stats")
    self.assertEqual(status, 403)

  def test_cannot_demote_last_admin(self):
    # Seeded admin is the only admin.
    me = next(u for u in self.c.request("GET", "/api/admin/users")[1]["users"]
              if u["username"] == SEED_USER)
    status, body = self.c.request("POST", f"/api/admin/users/{me['id']}/role", {"is_admin": False})
    self.assertEqual(status, 409, body)

  def test_revoke_sessions(self):
    # Bob is currently signed in.
    status, body = self.user_c.request("GET", "/api/state")
    self.assertTrue(body["authenticated"])
    status, _ = self.c.request("POST", f"/api/admin/users/{self._bob_id()}/revoke-sessions")
    self.assertEqual(status, 200)
    status, body = self.user_c.request("GET", "/api/state")
    self.assertFalse(body["authenticated"])

  def test_delete_user_removes_data(self):
    bob_id = self._bob_id()
    bob_dir = _server.data_dir / "users" / "bob"  # type: ignore[union-attr]
    bob_dir.mkdir(parents=True, exist_ok=True)
    (bob_dir / "places.json").write_text("[]", "utf-8")
    status, _ = self.c.request("DELETE", f"/api/admin/users/{bob_id}")
    self.assertEqual(status, 200)
    self.assertFalse(bob_dir.exists())
    names = {u["username"] for u in self.c.request("GET", "/api/admin/users")[1]["users"]}
    self.assertNotIn("bob", names)

  def test_cannot_delete_self(self):
    me = next(u for u in self.c.request("GET", "/api/admin/users")[1]["users"]
              if u["username"] == SEED_USER)
    status, _ = self.c.request("DELETE", f"/api/admin/users/{me['id']}")
    self.assertEqual(status, 409)

  def test_cannot_delete_last_admin(self):
    bob_id = self._bob_id()
    self.c.request("POST", f"/api/admin/users/{bob_id}/role", {"is_admin": True})
    # Now demote self via promoting only — can't, we'd need to delete the seeded admin.
    me = next(u for u in self.c.request("GET", "/api/admin/users")[1]["users"]
              if u["username"] == SEED_USER)
    # First delete bob to get back to one admin (seeded admin).
    # Then trying to delete the seeded admin via bob's session would require bob to be admin
    # AND not be deleting themselves. Cleanest: make bob the only admin, demote seeded, then
    # try to delete bob — but we can't demote the seeded admin if bob is the only other admin
    # we'd still have 2. Simplify by checking the self-delete path is rejected for last admin.
    # That's already covered by test_cannot_delete_self for the seeded admin.
    # Instead test: demote bob (back to non-admin), then try to delete the seeded admin (self).
    self.c.request("POST", f"/api/admin/users/{bob_id}/role", {"is_admin": False})
    status, _ = self.c.request("DELETE", f"/api/admin/users/{me['id']}")
    self.assertEqual(status, 409)


class TestAuditLogs(unittest.TestCase):
  """Admin audit log endpoint and event capture."""

  def setUp(self):
    self.c = admin_client()

  def _actions(self, limit: int = 50) -> list[str]:
    status, body = self.c.request("GET", f"/api/admin/logs?limit={limit}")
    self.assertEqual(status, 200)
    return [r["action"] for r in body["logs"]]

  def test_anon_blocked(self):
    anon = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = anon.request("GET", "/api/admin/logs")
    self.assertEqual(status, 401)

  def test_non_admin_blocked(self):
    self.c.request("POST", "/api/settings/registration", {"mode": "open"})
    user_c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = user_c.request("POST", "/api/register",
                               {"username": "logviewer", "password": "logviewer-password"})
    if status == 409:
      user_c.login("logviewer", "logviewer-password")
    self.c.request("POST", "/api/settings/registration", {"mode": "closed"})
    try:
      status, _ = user_c.request("GET", "/api/admin/logs")
      self.assertEqual(status, 403)
    finally:
      for u in self.c.request("GET", "/api/admin/users")[1].get("users") or []:
        if u["username"] != SEED_USER:
          self.c.request("DELETE", f"/api/admin/users/{u['id']}")

  def test_login_success_logged(self):
    Client(_server.base_url).login(SEED_USER, "test-password-1234")  # type: ignore[union-attr]
    self.assertIn("auth.login_success", self._actions())

  def test_login_failure_logged(self):
    bad = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = bad.request("POST", "/api/login",
                            {"username": "ghost-user-xyz", "password": "nope"})
    self.assertEqual(status, 401)
    self.assertIn("auth.login_failure", self._actions())

  def test_publish_toggle_logged(self):
    before = self._actions().count("user.publish_toggle")
    self.c.request("POST", "/api/me/publish", {"published": True})
    self.c.request("POST", "/api/me/publish", {"published": False})
    after = self._actions().count("user.publish_toggle")
    self.assertEqual(after - before, 2)

  def test_pagination_cursor(self):
    # Generate a handful of events.
    for _ in range(3):
      self.c.request("POST", "/api/me/publish", {"published": True})
      self.c.request("POST", "/api/me/publish", {"published": False})
    status, body = self.c.request("GET", "/api/admin/logs?limit=2")
    self.assertEqual(status, 200)
    self.assertEqual(len(body["logs"]), 2)
    self.assertIsNotNone(body["next_before_id"])
    first_ids = [r["id"] for r in body["logs"]]
    status, body2 = self.c.request("GET", f"/api/admin/logs?limit=2&before_id={body['next_before_id']}")
    self.assertEqual(status, 200)
    second_ids = [r["id"] for r in body2["logs"]]
    self.assertFalse(set(first_ids) & set(second_ids))
    # Newest-first ordering preserved across pages.
    self.assertGreater(min(first_ids), max(second_ids))


class TestStaticPWAHeaders(unittest.TestCase):
  """Verify static handler serves PWA files with correct headers."""

  def setUp(self):
    # Drop minimal stand-in files into the server's static_dir so we don't
    # depend on the repo-root manifest/sw.js layout.
    (_server.data_dir / "manifest.webmanifest").write_text('{"name":"x"}', encoding="utf-8")
    (_server.data_dir / "sw.js").write_text("// stub", encoding="utf-8")

  def _head(self, path: str):
    url = _server.base_url + path
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req) as r:
      return r.status, dict(r.headers)

  def test_manifest_content_type(self):
    status, headers = self._head("/manifest.webmanifest")
    self.assertEqual(status, 200)
    self.assertEqual(headers.get("Content-Type"), "application/manifest+json")

  def test_sw_cache_control(self):
    status, headers = self._head("/sw.js")
    self.assertEqual(status, 200)
    # Must not be cached by HTTP cache, so SW updates can roll out.
    self.assertEqual(headers.get("Cache-Control"), "no-cache")


class TestCrossOrigin(unittest.TestCase):
  """Bearer-token auth and CORS for cross-origin / native clients."""

  def _raw(self, method, path, body=None, headers=None):
    """Cookie-free request; returns (status, headers dict, parsed body)."""
    url = _server.base_url + path  # type: ignore[union-attr]
    data = None
    h = dict(headers or {})
    if body is not None:
      data = json.dumps(body).encode("utf-8")
      h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
      with urllib.request.urlopen(req) as r:
        payload = r.read()
        return r.status, dict(r.headers), (json.loads(payload) if payload else None)
    except urllib.error.HTTPError as e:
      payload = e.read()
      try:
        parsed = json.loads(payload) if payload else None
      except json.JSONDecodeError:
        parsed = payload.decode("utf-8", "replace")
      return e.code, dict(e.headers), parsed

  def _bearer_login(self):
    status, headers, body = self._raw(
      "POST", "/api/login", {"username": SEED_USER, "password": SEED_PW, "token": True})
    self.assertEqual(status, 200)
    return headers, body

  def test_login_token_returns_bearer_and_no_cookie(self):
    headers, body = self._bearer_login()
    self.assertIn("session_token", body)
    self.assertEqual(body["token_type"], "Bearer")
    # Opting into a body token must not also set the HttpOnly cookie.
    self.assertIsNone(headers.get("Set-Cookie"))

  def test_normal_login_keeps_cookie_only(self):
    # Without the opt-in, the token never appears in the body (HttpOnly path).
    status, headers, body = self._raw(
      "POST", "/api/login", {"username": SEED_USER, "password": SEED_PW})
    self.assertEqual(status, 200)
    self.assertNotIn("session_token", body)
    self.assertIn("session", headers.get("Set-Cookie", ""))

  def test_bearer_token_authenticates(self):
    _, body = self._bearer_login()
    tok = body["session_token"]
    status, _, state = self._raw("GET", "/api/state",
                                 headers={"Authorization": "Bearer " + tok})
    self.assertEqual(status, 200)
    self.assertTrue(state["authenticated"])
    self.assertEqual(state["username"], SEED_USER)

  def test_bearer_session_appears_in_sessions_list(self):
    _, body = self._bearer_login()
    tok = body["session_token"]
    status, _, data = self._raw("GET", "/api/sessions",
                                headers={"Authorization": "Bearer " + tok})
    self.assertEqual(status, 200)
    self.assertTrue(any(s["current"] for s in data["sessions"]))

  def test_bearer_logout_revokes_session(self):
    _, body = self._bearer_login()
    tok = body["session_token"]
    auth = {"Authorization": "Bearer " + tok}
    self.assertEqual(self._raw("POST", "/api/logout", headers=auth)[0], 200)
    # Token is dead after logout.
    _, _, state = self._raw("GET", "/api/state", headers=auth)
    self.assertFalse(state["authenticated"])

  def test_cors_preflight(self):
    status, headers, _ = self._raw(
      "OPTIONS", "/api/state",
      headers={"Origin": "https://app.example.com",
               "Access-Control-Request-Method": "GET",
               "Access-Control-Request-Headers": "authorization"})
    self.assertEqual(status, 204)
    self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
    self.assertIn("Authorization", headers.get("Access-Control-Allow-Headers", ""))

  def test_cors_header_on_response(self):
    _, headers, _ = self._raw("GET", "/api/health")
    self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
    # Bearer-only cross-origin: never advertise credential support.
    self.assertIsNone(headers.get("Access-Control-Allow-Credentials"))


if __name__ == "__main__":
  unittest.main()
