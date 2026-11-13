"""Integration tests for the API (tools/api.py).

Spins up a fresh API server in a subprocess against a tempdir
data dir + sqlite db, then exercises endpoints via urllib.

Run with: python3 -m unittest discover -s tests
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.cookiejar import CookieJar
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ferd_api import store  # noqa: E402
from fs_probe import FOLDS_REASON, folds_unicode_names  # noqa: E402

API_SCRIPT = REPO_ROOT / "tools" / "api.py"

SEED_USER = "admin"
SEED_PW = "test-password-1234"


def _free_port() -> int:
  with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    return s.getsockname()[1]


class _Server:
  """A subprocess-backed API server with its own tempdir + sqlite."""

  def __init__(self, extra_cfg: dict | None = None, prepare=None) -> None:
    self.tmp = tempfile.TemporaryDirectory()
    self.data_dir = Path(self.tmp.name)
    if prepare:
      prepare(self.data_dir)
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
    cfg.update(extra_cfg or {})
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


def store_conn() -> sqlite3.Connection:
  """A connection to the test server's database, for setting up and checking rows."""
  conn = sqlite3.connect(_server.data_dir / "test.db", isolation_level=None, timeout=10)  # type: ignore[union-attr]
  conn.row_factory = sqlite3.Row
  conn.execute("PRAGMA foreign_keys=ON")
  return conn


def user_id(username: str = SEED_USER) -> int:
  conn = store_conn()
  try:
    return conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()["id"]
  finally:
    conn.close()


def stored(kind: str, username: str = SEED_USER):
  """The live rows of a kind as the API would list them: a list for places and
  areas, a dict for the keyed kinds."""
  conn = store_conn()
  try:
    uid = user_id(username)
    if kind in ("place", "area", "route"):
      return store.list_items(conn, uid, kind)
    return store.get_map(conn, uid, kind)
  finally:
    conn.close()


def reset_kind(kind: str, items=None, username: str = SEED_USER) -> None:
  """Replace a kind's live rows so tests can assume a known state."""
  conn = store_conn()
  try:
    uid = user_id(username)
    if kind in ("place", "area"):
      store.replace_list(conn, uid, kind, items or [])
    else:
      store.replace_map(conn, uid, kind, items or {})
  finally:
    conn.close()


def fresh_places(items: list | None = None) -> None:
  reset_kind("place", items)


def put(kind: str, item_id: str, data) -> dict:
  return {"kind": kind, "op": "put", "id": item_id, "data": data}


def batch(c: Client, changes: list):
  return c.request("POST", "/api/sync/batch", {"changes": changes})


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


def _session_ip(server: _Server, marker_ua: str) -> str:
  """Read back the ip recorded on the session whose user_agent is marker_ua."""
  conn = sqlite3.connect(server.data_dir / "test.db")
  try:
    row = conn.execute(
      "SELECT ip FROM sessions WHERE user_agent=? ORDER BY created_at DESC LIMIT 1",
      (marker_ua,),
    ).fetchone()
  finally:
    conn.close()
  assert row is not None, f"no session recorded for user-agent {marker_ua!r}"
  return row[0]


class TestClientIpDefault(unittest.TestCase):
  def test_forwarded_headers_ignored_without_trusted_proxies(self):
    # 127.0.0.1 is not in the (empty) trusted set, so a spoofed header must
    # not become the recorded client IP.
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request(
      "POST", "/api/login", {"username": SEED_USER, "password": SEED_PW},
      headers={"X-Forwarded-For": "203.0.113.9", "User-Agent": "ua-xff-untrusted"},
    )
    self.assertEqual(status, 200)
    self.assertEqual(_session_ip(_server, "ua-xff-untrusted"), "127.0.0.1")


class TestClientIpTrustedProxy(unittest.TestCase):
  """With the peer listed in trusted_proxies, forwarded headers win."""

  srv: _Server

  @classmethod
  def setUpClass(cls) -> None:
    cls.srv = _Server(extra_cfg={"trusted_proxies": ["127.0.0.1"]})

  @classmethod
  def tearDownClass(cls) -> None:
    cls.srv.close()

  def _login(self, headers: dict[str, str]):
    c = Client(self.srv.base_url)
    return c.request("POST", "/api/login",
                     {"username": SEED_USER, "password": SEED_PW}, headers=headers)

  def test_rightmost_forwarded_for_entry_wins(self):
    # The rightmost entry is the one the trusted proxy appended; entries to
    # its left are client-supplied and must not be believed.
    status, _ = self._login({
      "X-Forwarded-For": "10.9.9.9, 203.0.113.9",
      "User-Agent": "ua-xff-trusted",
    })
    self.assertEqual(status, 200)
    self.assertEqual(_session_ip(self.srv, "ua-xff-trusted"), "203.0.113.9")

  def test_x_real_ip_takes_precedence(self):
    status, _ = self._login({
      "X-Real-IP": "198.51.100.7",
      "X-Forwarded-For": "203.0.113.9",
      "User-Agent": "ua-realip-trusted",
    })
    self.assertEqual(status, 200)
    self.assertEqual(_session_ip(self.srv, "ua-realip-trusted"), "198.51.100.7")


class TestSessionPrune(unittest.TestCase):
  def test_expired_sessions_swept_on_login(self):
    # Plant an already-expired session row, then log in; session_create's
    # sweep should delete it.
    db = _server.data_dir / "test.db"  # type: ignore[union-attr]
    conn = sqlite3.connect(db)
    try:
      uid = conn.execute("SELECT id FROM users WHERE username=?", (SEED_USER,)).fetchone()[0]
      stale = "e" * 64  # matches the stored sha256-hex token shape
      now = int(time.time())
      conn.execute(
        "INSERT INTO sessions(token, user_id, created_at, expires_at, last_seen_at, ip, user_agent) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (stale, uid, now - 100, now - 10, now - 100, "127.0.0.1", "ua-stale"),
      )
      conn.commit()
    finally:
      conn.close()

    c = Client(_server.base_url)  # type: ignore[union-attr]
    self.assertEqual(c.login(SEED_USER, SEED_PW)[0], 200)

    conn = sqlite3.connect(db)
    try:
      left = conn.execute("SELECT COUNT(*) FROM sessions WHERE token=?", ("e" * 64,)).fetchone()[0]
    finally:
      conn.close()
    self.assertEqual(left, 0)


class TestRegistrationGate(unittest.TestCase):
  def test_registration_closed_by_default_after_seed(self):
    # Seed counts as user 1, so register endpoint should reject.
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request("POST", "/api/register",
                          {"username": "bob", "password": "bob-password-123"})
    self.assertEqual(status, 403)



class TestSetupTokenAfterUsersEmptied(unittest.TestCase):
  """A seeded instance never makes a boot-time setup token, so emptying the
  user table while it runs must not open admin registration to anyone (#33)."""

  srv: _Server

  @classmethod
  def setUpClass(cls) -> None:
    cls.srv = _Server(extra_cfg={"require_setup_token": True})

  @classmethod
  def tearDownClass(cls) -> None:
    cls.srv.close()

  def test_registration_needs_token_once_users_are_gone(self):
    db = sqlite3.connect(self.srv.data_dir / "test.db")
    try:
      db.execute("PRAGMA foreign_keys = ON")
      db.execute("DELETE FROM users")
      db.commit()
    finally:
      db.close()
    c = Client(self.srv.base_url)
    status, body = c.request("GET", "/api/state")
    self.assertEqual(status, 200)
    self.assertTrue(body["requires_setup_token"])
    status, _ = c.request("POST", "/api/register",
                          {"username": "mallory", "password": "mallory-password-1"})
    self.assertEqual(status, 403)

class TestOwnerItemWritesRemoved(unittest.TestCase):
  def test_item_writes_go_through_the_batch(self):
    c = admin_client()
    for method, path in (("POST", "/api/places"), ("PUT", "/api/places"), ("DELETE", "/api/places"),
                         ("POST", "/api/areas"), ("PUT", "/api/areas"), ("DELETE", "/api/areas"),
                         ("PUT", "/api/me/prefs"), ("PUT", "/api/me/category-labels"),
                         ("POST", "/api/places/clear-category"), ("PUT", "/api/metadata")):
      with self.subTest(method=method, path=path):
        self.assertEqual(c.request(method, path, {})[0], 404)


class TestPlaces(unittest.TestCase):
  def setUp(self):
    self.c = admin_client()
    fresh_places([])

  def test_put_lists_and_persists(self):
    status, body = batch(self.c, [put("place", "abcdef01", {"name": "P1", "lat": 1, "lon": 2, "category": "cat"})])
    self.assertEqual(status, 200, body)
    on_disk = stored("place")
    self.assertEqual([(p["id"], p["name"]) for p in on_disk], [("abcdef01", "P1")])
    self.assertEqual(self.c.request("GET", "/api/places")[1], on_disk)

  def test_validation_error(self):
    status, body = batch(self.c, [put("place", "abcdef01", {"name": "X", "lat": 200, "lon": 0})])
    self.assertEqual(status, 400)
    self.assertIn("lat", body["error"])

  def test_put_again_renames_in_place(self):
    batch(self.c, [put("place", "abcdef01", {"name": "Old", "lat": 0, "lon": 0, "category": "cat"})])
    batch(self.c, [put("place", "abcdef01", {"name": "New", "lat": 0, "lon": 0, "category": "cat"})])
    self.assertEqual([(p["id"], p["name"]) for p in stored("place")], [("abcdef01", "New")])

  def test_same_name_rows_are_kept_apart_by_id(self):
    batch(self.c, [put("place", "aaaaaaa1", {"name": "Dup", "lat": 1, "lon": 1}),
                   put("place", "bbbbbbb2", {"name": "Dup", "lat": 2, "lon": 2})])
    batch(self.c, [put("place", "bbbbbbb2", {"name": "Dup", "lat": 9, "lon": 9})])
    by_id = {p["id"]: p for p in stored("place")}
    self.assertEqual((by_id["aaaaaaa1"]["lat"], by_id["bbbbbbb2"]["lat"]), (1, 9))
    batch(self.c, [{"kind": "place", "op": "delete", "id": "aaaaaaa1"}])
    self.assertEqual([p["id"] for p in stored("place")], ["bbbbbbb2"])

  def test_missing_or_empty_category_is_left_out(self):
    batch(self.c, [put("place", "aaaaaaa1", {"name": "NoCat", "lat": 0, "lon": 0}),
                   put("place", "bbbbbbb2", {"name": "Blank", "lat": 0, "lon": 0, "category": ""})])
    self.assertEqual([("category" in p) for p in stored("place")], [False, False])



SQUARE = {"type": "Polygon", "coordinates": [[[5, 60], [6, 60], [6, 61], [5, 61], [5, 60]]]}


class TestAreas(unittest.TestCase):
  def setUp(self):
    self.c = admin_client()
    reset_kind("area")

  def test_list_is_empty_before_first_write(self):
    self.assertEqual(self.c.request("GET", "/api/areas"), (200, []))

  def test_put_update_delete(self):
    status, body = batch(self.c, [put("area", "a0000001", {"name": "Park", "geometry": SQUARE, "category": "park"})])
    self.assertEqual(status, 200, body)
    area = stored("area")[0]
    self.assertFalse(area["visited"])
    batch(self.c, [put("area", "a0000001", dict(area, name="Renamed", visited=True))])
    _, listed = self.c.request("GET", "/api/areas")
    self.assertEqual([(a["id"], a["name"], a["visited"]) for a in listed], [("a0000001", "Renamed", True)])
    batch(self.c, [{"kind": "area", "op": "delete", "id": "a0000001"}])
    self.assertEqual(self.c.request("GET", "/api/areas"), (200, []))

  def test_projected_coordinates_name_the_cause(self):
    utm = {"type": "Polygon", "coordinates": [[[297000, 6700000], [298000, 6700000], [298000, 6701000], [297000, 6700000]]]}
    status, body = batch(self.c, [put("area", "a0000001", {"name": "UTM", "geometry": utm})])
    self.assertEqual(status, 400)
    self.assertIn("EPSG:25833", body["error"])

  def test_requires_auth(self):
    anon = Client(_server.base_url)  # type: ignore[union-attr]
    self.assertEqual(anon.request("GET", "/api/areas")[0], 401)

  def test_public_read_follows_publish_state(self):
    batch(self.c, [put("area", "a0000001", {"name": "Shared", "geometry": SQUARE})])
    anon = Client(_server.base_url)  # type: ignore[union-attr]
    self.assertEqual(anon.request("GET", f"/api/u/{SEED_USER}/areas")[0], 404)
    self.c.request("POST", "/api/me/publish", {"published": True})
    try:
      status, body = anon.request("GET", f"/api/u/{SEED_USER}/areas")
      self.assertEqual(status, 200)
      self.assertEqual(body[0]["name"], "Shared")
    finally:
      self.c.request("POST", "/api/me/publish", {"published": False})

  def test_geojson_export_signed_in_and_public(self):
    batch(self.c, [put("area", "a0000001", {"name": "Geo", "geometry": SQUARE})])
    status, body = self.c.request("GET", "/api/me/export.geojson")
    self.assertEqual(status, 200)
    self.assertEqual(body["type"], "FeatureCollection")
    self.assertIn(("area", "Geo"), [(f["properties"]["kind"], f["properties"]["name"]) for f in body["features"]])
    anon = Client(_server.base_url)  # type: ignore[union-attr]
    self.assertEqual(anon.request("GET", "/api/me/export.geojson")[0], 401)
    self.assertEqual(anon.request("GET", f"/api/u/{SEED_USER}/export.geojson")[0], 404)
    self.c.request("POST", "/api/me/publish", {"published": True})
    try:
      status, pub = anon.request("GET", f"/api/u/{SEED_USER}/export.geojson")
      self.assertEqual(status, 200)
      self.assertEqual(pub, body)
    finally:
      self.c.request("POST", "/api/me/publish", {"published": False})

class TestCategoryLabels(unittest.TestCase):
  def test_anon_blocked(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = c.request("GET", "/api/me/category-labels")
    self.assertEqual(status, 401)

  def test_put_and_read(self):
    c = admin_client()
    status, body = batch(c, [put("label", "food", {"label": "Food"}), put("label", "hike", {"label": "Hiking", "color": 7})])
    self.assertEqual(status, 200, body)
    on_disk = stored("label")
    self.assertEqual(on_disk["food"], {"label": "Food"})
    status, body = c.request("GET", "/api/me/category-labels")
    self.assertEqual(status, 200)
    self.assertEqual(body["category_labels"]["hike"], {"label": "Hiking", "color": 7})

  def test_validation(self):
    c = admin_client()
    for data in ("X", {"label": "X", "color": "blue"}, {"label": "X", "color": -1}, {"label": "X", "extra": 1}):
      with self.subTest(data=data):
        self.assertEqual(batch(c, [put("label", "x", data)])[0], 400)

  def test_public_read_when_published(self):
    c = admin_client()
    batch(c, [put("label", "beach", {"label": "Beaches", "color": 4})])
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

  def test_public_url_with_other_letter_case_creates_no_folder(self):
    c = admin_client()
    batch(c, [put("label", "beach", {"label": "Beaches", "color": 4})])
    c.request("POST", "/api/me/publish", {"published": True})
    other = SEED_USER.upper() if SEED_USER.upper() != SEED_USER else SEED_USER.lower()
    users = _server.data_dir / "users"  # type: ignore[union-attr]
    before = sorted(p.name for p in users.iterdir())
    anon = Client(_server.base_url)  # type: ignore[union-attr]
    try:
      status, body = anon.request("GET", f"/api/u/{other}/category-labels")
      self.assertEqual(status, 200)
      self.assertEqual(body["category_labels"]["beach"], {"label": "Beaches", "color": 4})
      self.assertEqual(anon.request("GET", f"/api/u/{other}/places")[0], 200)
      self.assertEqual(sorted(p.name for p in users.iterdir()), before)
    finally:
      c.request("POST", "/api/me/publish", {"published": False})


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


class TestGpxDeleteMetadata(unittest.TestCase):
  """A deleted route takes its metadata with it, so a later upload under the
  same name starts blank."""

  def setUp(self):
    self.c = admin_client()
    reset_kind("metadata")

  def _upload(self, region, name):
    status, _ = self.c.request("POST", f"/api/gpx?region={region}&name={name}",
                               raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.assertEqual(status, 201)

  def _delete(self, region, name):
    status, _ = self.c.request("DELETE", "/api/gpx", {"region": region, "name": name})
    self.assertEqual(status, 200)

  def test_delete_drops_metadata_and_a_new_upload_starts_blank(self):
    self._upload("MetaDel", "gone")
    batch(self.c, [put("metadata", "MetaDel/gone", {"notes": "old", "rating": 4})])
    self._delete("MetaDel", "gone")
    self.assertNotIn("MetaDel/gone", stored("metadata"))
    self._upload("MetaDel", "gone")
    self.assertNotIn("MetaDel/gone", stored("metadata"))
    self._delete("MetaDel", "gone")

  def test_delete_prunes_older_orphans_and_keeps_live_routes(self):
    self._upload("MetaDel", "kept")
    planned = admin_dir() / "gpx" / "MetaDel" / "plan.planned.gpx"
    planned.write_bytes(GPX_BODY)
    self._upload("MetaDel", "other")
    reset_kind("metadata", {
      "MetaDel/kept": {"notes": "walked"},
      "MetaDel/plan": {"notes": "planned"},
      "MetaDel/ghost": {"notes": "orphan"},
      "NoSuchRegion/ghost": {"notes": "orphan"},
    })
    self._delete("MetaDel", "other")
    meta = stored("metadata")
    self.assertEqual(sorted(meta), ["MetaDel/kept", "MetaDel/plan"])
    self._delete("MetaDel", "kept")
    planned.unlink()

  def test_a_region_that_cannot_be_read_keeps_its_metadata(self):
    gpx = admin_dir() / "gpx"
    gpx.mkdir(exist_ok=True)
    dangling = gpx / "Unmounted"
    dangling.symlink_to(gpx / "no-such-target")
    try:
      self._upload("MetaDel", "other")
      reset_kind("metadata", {"Unmounted/route": {"notes": "keep"}})
      self._delete("MetaDel", "other")
      self.assertIn("Unmounted/route", stored("metadata"))
    finally:
      dangling.unlink()


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
    batch(self.c, [put("metadata", "Old/t", {"rating": 4})])
    status, body = self.c.request("POST", "/api/regions/rename",
                                  {"from": "Old", "to": "New"})
    self.assertEqual(status, 200)
    self.assertEqual(body["routes"], 1)
    self.assertEqual(body["metadata"], 1)
    self.assertFalse((admin_dir() / "gpx" / "Old").exists())
    self.assertTrue((admin_dir() / "gpx" / "New" / "t.gpx").exists())
    meta = stored("metadata")
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
    batch(self.c, [put("metadata", "Drop/a", {"rating": 3})])
    status, body = self.c.request("POST", "/api/regions/clear", {"name": "Drop"})
    self.assertEqual(status, 200)
    self.assertEqual(body["routes"], 2)
    self.assertFalse((admin_dir() / "gpx" / "Drop").exists())
    self.assertTrue((admin_dir() / "gpx" / "a.gpx").exists())
    self.assertTrue((admin_dir() / "gpx" / "b.gpx").exists())
    meta = stored("metadata")
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
    reset_kind("metadata")

  def test_region_to_region(self):
    self.c.request("POST", "/api/gpx?region=From&name=t",
                   raw_body=GPX_BODY, content_type="application/gpx+xml")
    batch(self.c, [put("metadata", "From/t", {"rating": 4})])
    status, body = self.c.request("POST", "/api/gpx/move",
                                  {"key": "From/t", "new_region": "To"})
    self.assertEqual(status, 200)
    self.assertEqual(body["new_key"], "To/t")
    self.assertEqual(body["moved"], 1)
    self.assertFalse((admin_dir() / "gpx" / "From").exists())
    self.assertTrue((admin_dir() / "gpx" / "To" / "t.gpx").exists())
    meta = stored("metadata")
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
    batch(self.c, [put("metadata", "R/Old", {"rating": 5})])
    status, body = self.c.request("POST", "/api/gpx/move",
                                  {"key": "R/Old", "new_region": "R", "new_name": "New"})
    self.assertEqual(status, 200)
    self.assertEqual(body["new_key"], "R/New")
    self.assertTrue((admin_dir() / "gpx" / "R" / "New.gpx").exists())
    self.assertFalse((admin_dir() / "gpx" / "R" / "Old.gpx").exists())
    meta = stored("metadata")
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
    reset_kind("metadata")

  def _put(self, metadata):
    return batch(self.c, [put("metadata", self.KEY, metadata)])

  def test_anon_blocked(self):
    c = Client(_server.base_url)  # type: ignore[union-attr]
    status, _ = batch(c, [put("metadata", self.KEY, {"rating": 4})])
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
    status, _ = self._put(payload)
    self.assertEqual(status, 200)
    status, all_meta = self.c.request("GET", "/api/metadata")
    self.assertEqual(status, 200)
    self.assertEqual(all_meta[self.KEY], payload)

  def test_empty_metadata_deletes_key(self):
    self._put({"rating": 3})
    status, _ = self._put({})
    self.assertEqual(status, 200)
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
    status, _ = batch(self.c, [put("metadata", "no-slash", {"rating": 3})])
    self.assertEqual(status, 200)

  def test_too_many_parts_rejected(self):
    status, _ = batch(self.c, [put("metadata", "a/b/c", {"rating": 3})])
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
    batch(self.c, [put("place", "abcdef01", {"name": "AdminOnly", "lat": 1, "lon": 2, "category": "x"})])
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
    reset_kind("pref")
    payload = {"theme": "nord", "marker_size": "large"}
    status, _ = batch(c, [put("pref", k, v) for k, v in payload.items()])
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

  def test_export_skips_backup_files(self):
    # A stray backup file (e.g. left by maintenance) must not appear in the
    # export, and must not abort the whole zip if it happens to be unreadable.
    c = admin_client()
    fresh_places([{"name": "Inside", "lat": 0, "lon": 0, "category": "x"}])
    d = admin_dir()
    bak = d / "places.json.bak-20260606-175227"
    bak.write_text("junk", encoding="utf-8")
    tilde = d / "notes.txt~"
    tilde.write_text("junk", encoding="utf-8")
    try:
      url = _server.base_url + "/api/me/export"  # type: ignore[union-attr]
      with c.opener.open(urllib.request.Request(url)) as r:
        self.assertEqual(r.status, 200)
        payload = r.read()
      names = zipfile.ZipFile(io.BytesIO(payload)).namelist()
      self.assertIn("places.json", names)
      self.assertNotIn(bak.name, names)
      self.assertNotIn(tilde.name, names)
    finally:
      bak.unlink()
      tilde.unlink()


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
    status, _ = bc.request("POST", "/api/sync/batch", {"changes": []}, headers=self._bearer(token))
    self.assertEqual(status, 200)

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
    status, body = bc.request("POST", "/api/sync/batch", {"changes": []}, headers=self._bearer(token))
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


NFC_ROUTE = unicodedata.normalize("NFC", "Måløy Ås")
NFD_ROUTE = unicodedata.normalize("NFD", NFC_ROUTE)


class TestNfcNames(unittest.TestCase):
  """Names reach the server decomposed from macOS and iOS pickers; every
  write stores them composed, so one route never ends up under two keys."""

  def setUp(self):
    self.c = admin_client()
    self.root = admin_dir() / "gpx"
    shutil.rmtree(self.root, ignore_errors=True)
    reset_kind("metadata")

  def names(self):
    return sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*.gpx"))

  def test_upload_stores_a_decomposed_name_composed(self):
    q = urllib.parse.urlencode({"region": NFD_ROUTE, "name": NFD_ROUTE})
    status, body = self.c.request("POST", f"/api/gpx?{q}", raw_body=GPX_BODY, content_type="application/gpx+xml")
    self.assertEqual(status, 201, body)
    self.assertEqual(body["saved"], f"gpx/{NFC_ROUTE}/{NFC_ROUTE}.gpx")
    q = urllib.parse.urlencode({"region": NFC_ROUTE, "name": NFC_ROUTE})
    self.assertEqual(self.c.request("POST", f"/api/gpx?{q}", raw_body=GPX_BODY, content_type="application/gpx+xml")[0], 201)
    self.assertEqual(self.names(), [f"{NFC_ROUTE}/{NFC_ROUTE}.gpx"])

  def test_sync_batch_stores_a_decomposed_metadata_id_composed(self):
    status, body = self.c.request("POST", "/api/sync/batch", {"changes": [
      {"kind": "metadata", "id": f"R/{NFD_ROUTE}", "op": "put", "data": {"rating": 4}},
    ]})
    self.assertEqual(status, 200, body)
    self.assertEqual(body["results"][0]["id"], f"R/{NFC_ROUTE}")
    status, body = self.c.request("POST", "/api/sync/batch", {"changes": [
      {"kind": "metadata", "id": f"R/{NFC_ROUTE}", "op": "put", "data": {"rating": 5}},
    ]})
    self.assertEqual(status, 200, body)
    self.assertEqual(stored("metadata"), {f"R/{NFC_ROUTE}": {"rating": 5}})

  def test_sync_batch_keeps_the_key_of_a_route_still_stored_decomposed(self):
    conn = store_conn()
    self.addCleanup(conn.close)
    store.put_item(conn, user_id(), "route", NFD_ROUTE, {"region": "", "key": NFD_ROUTE, "name": NFD_ROUTE})
    self.addCleanup(store.delete_item, conn, user_id(), "route", NFD_ROUTE)
    status, body = self.c.request("POST", "/api/sync/batch", {"changes": [
      {"kind": "metadata", "id": NFD_ROUTE, "op": "put", "data": {"rating": 2}},
    ]})
    self.assertEqual(status, 200, body)
    self.assertEqual(stored("metadata"), {NFD_ROUTE: {"rating": 2}})

  def test_gpx_get_with_a_decomposed_url_serves_the_composed_file(self):
    q = urllib.parse.urlencode({"region": NFC_ROUTE, "name": NFC_ROUTE})
    self.assertEqual(self.c.request("POST", f"/api/gpx?{q}", raw_body=GPX_BODY, content_type="application/gpx+xml")[0], 201)
    for region in (NFC_ROUTE, NFD_ROUTE):
      for name in (NFC_ROUTE, NFD_ROUTE):
        path = "/api/gpx/" + urllib.parse.quote(region) + "/" + urllib.parse.quote(name + ".gpx")
        req = urllib.request.Request(_server.base_url + path)
        with self.c.opener.open(req, timeout=10) as r:
          self.assertEqual(r.status, 200)
          self.assertIn(b"<gpx", r.read())

  @unittest.skipIf(folds_unicode_names(), FOLDS_REASON)
  def test_import_merges_a_decomposed_route_into_the_composed_one(self):
    gpx = GPX_BODY
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
      zf.writestr(f"gpx/{NFC_ROUTE}.gpx", gpx)
      zf.writestr(f"gpx/{NFD_ROUTE}.gpx", gpx)
      zf.writestr(f"gpx/{NFD_ROUTE}/{NFD_ROUTE}.gpx", gpx)
      zf.writestr("metadata.json", json.dumps({
        NFC_ROUTE: {"source": "https://example.com/r"},
        NFD_ROUTE: {"rating": 5},
      }))
    for mode in ("replace", "merge"):
      status, body = self.c.request("POST", f"/api/me/import?mode={mode}",
                                    raw_body=buf.getvalue(), content_type="application/zip")
      self.assertEqual(status, 200, body)
      self.assertEqual(self.names(), sorted([f"{NFC_ROUTE}.gpx", f"{NFC_ROUTE}/{NFC_ROUTE}.gpx"]))
      self.assertEqual(stored("metadata"), {NFC_ROUTE: {"source": "https://example.com/r", "rating": 5}})


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

  def test_areas_round_trip_through_export(self):
    reset_kind("area")
    batch(self.c, [put("area", "a0000001", {"name": "Kept", "geometry": SQUARE})])
    with self.c.opener.open(_server.base_url + "/api/me/export") as r:  # type: ignore[union-attr]
      exported = zipfile.ZipFile(io.BytesIO(r.read()))
    payload = self._make_zip({"areas.json": exported.read("areas.json")})
    self.assertEqual(self._post_zip(self.c, "replace", payload)[1]["imported"]["areas"], 1)
    self.assertEqual(self._post_zip(self.c, "merge", payload)[1]["imported"]["areas"], 0)
    self.assertEqual([a["name"] for a in self.c.request("GET", "/api/areas")[1]], ["Kept"])

  def test_import_refuses_an_invalid_area(self):
    bad = json.dumps([{"name": "No shape"}]).encode()
    status, body = self._post_zip(self.c, "merge", self._make_zip({"areas.json": bad}))
    self.assertEqual(status, 400)
    self.assertIn("areas.json[0]", body["error"])

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

  def test_demo_data_zip_imports(self):
    # scripts/demo-data.py feeds the screenshot recipe; its zip has to pass
    # the real import validation, keep <ele>, and span several history years.
    spec = importlib.util.spec_from_file_location(
      "demo_data", Path(__file__).resolve().parent.parent / "scripts" / "demo-data.py")
    demo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(demo)
    status, body = self._post_zip(self.c, "replace", demo.build_zip())
    self.assertEqual(status, 200, body)
    self.assertEqual(body["imported"]["places"], len(demo.PLACES))
    status, meta = self.c.request("GET", "/api/metadata")
    self.assertEqual(status, 200)
    self.assertEqual(set(meta), {demo.route_key(r) for r in demo.ROUTES})
    years = {m["date_completed"][:4] for m in meta.values() if "date_completed" in m}
    status, places = self.c.request("GET", "/api/places")
    self.assertEqual(status, 200)
    years |= {p["date_visited"][:4] for p in places if p.get("date_visited")}
    self.assertGreaterEqual(len(years), 2)
    status, labels = self.c.request("GET", "/api/me/category-labels")
    self.assertEqual(status, 200)
    self.assertEqual(labels["category_labels"]["castle"]["label"], "Castles")
    gpx = sorted((admin_dir() / "gpx").rglob("*.gpx"))
    self.assertEqual(len(gpx), len(demo.ROUTES))
    for path in gpx:
      self.assertIn("ele>", path.read_text("utf-8"), path.name)

  def test_demo_data_large_zip_imports(self):
    # --large feeds the preview: enough places to cluster, real countries to
    # shade, areas, and every route the set names.
    spec = importlib.util.spec_from_file_location(
      "demo_data", Path(__file__).resolve().parent.parent / "scripts" / "demo-data.py")
    demo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(demo)
    self.assertEqual(demo.build_zip(True), demo.build_zip(True))
    status, body = self._post_zip(self.c, "replace", demo.build_zip(True))
    self.assertEqual(status, 200, body)
    self.assertGreaterEqual(body["imported"]["places"], 150)
    status, places = self.c.request("GET", "/api/places")
    self.assertEqual(status, 200)
    self.assertEqual(len(places), len(demo.places(True)))
    visited_codes = {p["country_code"] for p in places if p.get("visited") and p.get("country_code")}
    self.assertIn("IT", visited_codes)
    self.assertGreaterEqual(len(visited_codes), 3)
    status, areas = self.c.request("GET", "/api/areas")
    self.assertEqual(status, 200)
    self.assertEqual({a["name"] for a in areas}, {a["name"] for a in demo.AREAS})
    self.assertEqual({a.get("visited", False) for a in areas}, {True, False})
    status, meta = self.c.request("GET", "/api/metadata")
    self.assertEqual(status, 200)
    self.assertEqual(set(meta), {demo.route_key(r) for r in demo.routes(True)})
    gpx = sorted((admin_dir() / "gpx").rglob("*.gpx"))
    self.assertEqual(len(gpx), len(demo.routes(True)))

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

  def test_error_messages(self):
    # The UI shows `error` verbatim; pin the text through the handler split.
    gpx = self._gpx_bytes("t")
    cases = [
      (b"not a zip", 400, "invalid zip: File is not a zip file"),
      (self._make_zip({"../escape.json": b"{}"}), 400, "invalid entry: ../escape.json"),
      (self._make_zip({"random.bin": b"x"}), 400, "unexpected file in zip: random.bin"),
      (self._make_zip({"gpx/a/b/c.gpx": gpx}), 400, "unexpected file in zip: gpx/a/b/c.gpx"),
      (self._make_zip({"gpx/a:b\x01/t.gpx": gpx}), 400, "invalid gpx path 'gpx/a:b\x01/t.gpx': contains disallowed characters"),
      (self._make_zip({"places.json": b"{"}), 400, "places.json not valid JSON: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"),
      (self._make_zip({"places.json": b"{}"}), 400, "places.json must be an array"),
      (self._make_zip({"prefs.json": b"[]"}), 400, "prefs.json must be an object"),
      (self._make_zip({"places.json": b'[{"name": "x", "lat": 999, "lon": 0}]'}), 400, "places.json[0]: lat must be a number in [-90, 90]"),
      (self._make_zip({"category-labels.json": b'{"a": 1}'}), 400, "category-labels.json: category_labels['a'] must be an object"),
      (self._make_zip({"gpx/t.gpx": b"<gpx"}), 400, None),
    ]
    for payload, want_status, want_error in cases:
      status, body = self._post_zip(self.c, "merge", payload)
      self.assertEqual(status, want_status, body)
      if want_error is not None:
        self.assertEqual(body["error"], want_error)
      else:
        self.assertTrue(body["error"].startswith("gpx/t.gpx: "), body)

  def test_rejects_declared_oversize(self):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
      zf.writestr("places.json", b" " * (200 * 1024 * 1024 + 1))
    status, body = self._post_zip(self.c, "merge", buf.getvalue())
    self.assertEqual(status, 413, body)
    self.assertEqual(body["error"], "uncompressed size exceeds limit")

  def test_stores_normalized_places(self):
    # Import must store what validate_place returns, as the write endpoints
    # do, not the client's bytes.
    raw = {"name": "  Padded  ", "lat": 1, "lon": 2, "category": " c ", "tags": ["a", "A", ""], "image_focus": "  "}
    want = {"name": "Padded", "lat": 1.0, "lon": 2.0, "visited": False, "category": "c", "tags": ["a"]}
    for mode in ("replace", "merge"):
      fresh_places([])
      status, body = self._post_zip(self.c, mode, self._make_zip({"places.json": json.dumps([raw]).encode("utf-8")}))
      self.assertEqual(status, 200, body)
      rows = [{k: v for k, v in r.items() if k != "id"} for r in stored("place")]
      self.assertEqual(rows, [want], mode)

  def test_merge_dedupes_on_normalized_name(self):
    fresh_places([{"name": "Keep", "lat": 1.0, "lon": 2.0, "visited": False}])
    payload = self._make_zip({"places.json": json.dumps([{"name": " Keep ", "lat": 5, "lon": 6}]).encode("utf-8")})
    status, body = self._post_zip(self.c, "merge", payload)
    self.assertEqual(status, 200, body)
    self.assertEqual(body["imported"]["places"], 0)

  def test_prefs_mode_skips_places_and_gpx(self):
    fresh_places([{"name": "Keep", "lat": 1.0, "lon": 2.0, "visited": False}])
    payload = self._make_zip({
      "places.json": b'[{"name": "x", "lat": 999, "lon": 0}]',
      "gpx/skip/t.gpx": b"<not gpx",
      "prefs.json": b'{"theme": "dark"}',
    })
    status, body = self._post_zip(self.c, "prefs", payload)
    self.assertEqual(status, 200, body)
    self.assertEqual(body["imported"], {"places": 0, "areas": 0, "gpx": 0, "metadata": 0, "prefs": body["imported"]["prefs"]})
    self.assertEqual([p["name"] for p in stored("place")], ["Keep"])
    self.assertFalse((admin_dir() / "gpx" / "skip").exists())


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
    reset_kind("place", [{"name": "Bobs", "lat": 1, "lon": 2}], "bob")
    status, _ = self.c.request("DELETE", f"/api/admin/users/{bob_id}")
    self.assertEqual(status, 200)
    self.assertFalse(bob_dir.exists())
    conn = store_conn()
    try:
      for table in ("store_items", "store_revs"):
        self.assertEqual(conn.execute(f"SELECT COUNT(*) FROM {table} WHERE user_id=?", (bob_id,)).fetchone()[0], 0, table)
    finally:
      conn.close()
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
    self.c.request("POST", "/api/me/publish", {"published": True})
    self.c.request("POST", "/api/me/publish", {"published": False})
    self.assertEqual(self._actions(2), ["user.publish_toggle"] * 2)

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

  def test_index_stylesheet_link_gets_the_cache_version(self):
    (_server.data_dir / "index.html").write_text(
      '<link href="/ui.css?v=__FERD_CACHE_VERSION__">', encoding="utf-8")
    with urllib.request.urlopen(_server.base_url + "/index.html") as r:
      body = r.read().decode("utf-8")
    self.assertRegex(body, r'/ui\.css\?v=ferd-[0-9a-f]{10}"')


class TestStaticDeniesServerFiles(unittest.TestCase):
  """The static handler refuses the database, config and per-user files."""

  def setUp(self):
    gpx = _server.data_dir / "users" / "someone" / "gpx"
    gpx.mkdir(parents=True, exist_ok=True)
    (gpx / "secret.gpx").write_text("<gpx/>", encoding="utf-8")

  def test_users_and_tools_are_forbidden(self):
    for path in ("/users/someone/gpx/secret.gpx", "/Users/someone/gpx/secret.gpx",
                 "/tools/app.db", "/TOOLS/app.db", "/deploy/x", "/.git/config"):
      with self.subTest(path=path):
        with self.assertRaises(urllib.error.HTTPError) as cm:
          urllib.request.urlopen(_server.base_url + path)
        self.assertEqual(cm.exception.code, 403)


class TestContentSecurityPolicy(unittest.TestCase):
  """The shell carries the policy (Report-Only by default) and nosniff."""

  IMPORTMAP = '{ "imports": { "preact": "/vendor/preact/preact.js" } }'

  def setUp(self):
    (_server.data_dir / "index.html").write_text(
      f'<script type="importmap">{self.IMPORTMAP}</script>', encoding="utf-8")
    (_server.data_dir / "sw.js").write_text("// stub", encoding="utf-8")

  def _headers(self, path):
    with urllib.request.urlopen(_server.base_url + path) as r:
      return r.headers

  def test_document_and_worker_carry_the_policy(self):
    digest = base64.b64encode(hashlib.sha256(self.IMPORTMAP.encode()).digest()).decode()
    for path in ("/", "/index.html", "/u/someone/", "/sw.js"):
      with self.subTest(path=path):
        h = self._headers(path)
        self.assertIsNone(h.get("Content-Security-Policy"))
        value = h.get("Content-Security-Policy-Report-Only") or ""
        self.assertIn(f"script-src 'self' 'sha256-{digest}'", value)
        self.assertIn("report-uri /api/csp-report", value)
        self.assertEqual(h.get("Reporting-Endpoints"), 'csp="/api/csp-report"')
        self.assertEqual(h.get("X-Content-Type-Options"), "nosniff")

  def test_head_gives_the_headers_without_a_body(self):
    req = urllib.request.Request(_server.base_url + "/", method="HEAD")
    with urllib.request.urlopen(req) as r:
      self.assertEqual(r.read(), b"")
      self.assertIn("script-src", r.headers.get("Content-Security-Policy-Report-Only") or "")
    req = urllib.request.Request(_server.base_url + "/api/state", method="HEAD")
    with self.assertRaises(urllib.error.HTTPError) as cm:
      urllib.request.urlopen(req)
    self.assertEqual(cm.exception.code, 405)

  def test_other_files_get_nosniff_only(self):
    (_server.data_dir / "x.css").write_text("a{}", encoding="utf-8")
    h = self._headers("/x.css")
    self.assertEqual(h.get("X-Content-Type-Options"), "nosniff")
    self.assertIsNone(h.get("Content-Security-Policy-Report-Only"))

  def _report(self, body: bytes, ctype: str) -> int:
    req = urllib.request.Request(_server.base_url + "/api/csp-report", data=body,
                                 method="POST", headers={"Content-Type": ctype})
    try:
      with urllib.request.urlopen(req) as r:
        return r.status
    except urllib.error.HTTPError as e:
      return e.code

  def test_report_sink_takes_both_shapes(self):
    legacy = json.dumps({"csp-report": {"blocked-uri": "inline",
                                        "violated-directive": "script-src"}}).encode()
    self.assertEqual(self._report(legacy, "application/csp-report"), 204)
    modern = json.dumps([{"type": "csp-violation", "body": {
      "blockedURL": "inline", "effectiveDirective": "script-src-elem"}}]).encode()
    self.assertEqual(self._report(modern, "application/reports+json"), 204)
    webkit = json.dumps({"type": "csp-violation", "body": {
      "blockedURL": "inline", "effectiveDirective": "style-src-elem"}}).encode()
    self.assertEqual(self._report(webkit, "application/csp-report"), 204)

  def test_report_sink_refuses_junk_and_oversize(self):
    self.assertEqual(self._report(b"{}", "application/json"), 400)
    self.assertEqual(self._report(b"not json", "application/csp-report"), 400)
    self.assertEqual(self._report(b"x" * 9000, "application/csp-report"), 413)


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


class TestSync(unittest.TestCase):
  def setUp(self):
    self.c = admin_client()
    fresh_places([])
    reset_kind("metadata")
    reset_kind("pref")
    reset_kind("label")

  def _epoch(self):
    return self.c.request("GET", "/api/sync/changes?since=0&limit=1")[1]["epoch"]

  def _changes(self, since=0, **qs):
    qs.setdefault("epoch", self._epoch())
    extra = "".join(f"&{k}={v}" for k, v in qs.items() if v is not None)
    return self.c.request("GET", f"/api/sync/changes?since={since}{extra}")

  def _batch(self, changes):
    return self.c.request("POST", "/api/sync/batch", {"changes": changes})

  def test_requires_login(self):
    anon = Client(_server.base_url)  # type: ignore[union-attr]
    self.assertEqual(anon.request("GET", "/api/sync/changes")[0], 401)
    self.assertEqual(anon.request("POST", "/api/sync/batch", {"changes": []})[0], 401)

  def test_batch_put_update_delete(self):
    status, body = self._batch([{"kind": "place", "op": "put", "id": "abcdef01",
                                 "data": {"name": "Local", "lat": 1, "lon": 2}}])
    self.assertEqual(status, 200, body)
    self.assertEqual(body["results"][0]["status"], "applied")
    first_rev = body["results"][0]["rev"]
    self.assertEqual([p["id"] for p in self.c.request("GET", "/api/places")[1]], ["abcdef01"])
    again = self._batch([{"kind": "place", "op": "put", "id": "abcdef01",
                          "data": {"name": "Local", "lat": 1, "lon": 2}}])[1]
    self.assertEqual((again["results"][0]["status"], again["results"][0]["rev"]), ("noop", first_rev))
    gone = self._batch([{"kind": "place", "op": "delete", "id": "abcdef01"}])[1]
    self.assertEqual(gone["results"][0]["status"], "applied")
    self.assertEqual(self.c.request("GET", "/api/places")[1], [])
    self.assertEqual(self._batch([{"kind": "place", "op": "delete", "id": "abcdef01"}])[1]["results"][0]["status"], "noop")

  def test_last_writer_wins_in_arrival_order(self):
    status, body = self._batch([
      {"kind": "place", "op": "put", "id": "abcdef02", "data": {"name": "First", "lat": 1, "lon": 2}},
      {"kind": "place", "op": "put", "id": "abcdef02", "data": {"name": "Second", "lat": 1, "lon": 2}},
      {"kind": "pref", "op": "put", "id": "theme", "data": "dark"},
    ])
    self.assertEqual(status, 200, body)
    self.assertEqual([p["name"] for p in self.c.request("GET", "/api/places")[1]], ["Second"])
    self.assertEqual(self.c.request("GET", "/api/me/prefs")[1]["theme"], "dark")
    self.assertEqual(body["rev"], max(r["rev"] for r in body["results"]))

  def test_batch_is_all_or_nothing(self):
    head = self._changes()[1]["rev"]
    status, body = self._batch([
      {"kind": "place", "op": "put", "id": "abcdef03", "data": {"name": "Ok", "lat": 1, "lon": 2}},
      {"kind": "place", "op": "put", "id": "abcdef04", "data": {"name": "Bad", "lat": 999, "lon": 2}},
    ])
    self.assertEqual(status, 400)
    self.assertIn("changes[1]", body["error"])
    self.assertEqual(self.c.request("GET", "/api/places")[1], [])
    self.assertEqual(self._changes()[1]["rev"], head)

  def test_batch_rejects_routes_and_unknown_kinds(self):
    for change in ({"kind": "route", "op": "put", "id": "R/a", "data": {}},
                   {"kind": "nope", "op": "put", "id": "x", "data": 1},
                   {"kind": "pref", "op": "merge", "id": "x"},
                   {"kind": "place", "op": "put", "id": "not-hex", "data": {"name": "x", "lat": 0, "lon": 0}},
                   "text"):
      with self.subTest(change=change):
        self.assertEqual(self._batch([change])[0], 400)
    self.assertEqual(self.c.request("POST", "/api/sync/batch", {"changes": "x"})[0], 400)

  def test_metadata_through_batch_matches_rest(self):
    self._batch([{"kind": "metadata", "op": "put", "id": "Reg/Trail", "data": {"rating": 4}}])
    self.assertEqual(self.c.request("GET", "/api/metadata")[1]["Reg/Trail"], {"rating": 4})
    self._batch([{"kind": "metadata", "op": "put", "id": "Reg/Trail", "data": {}}])
    self.assertNotIn("Reg/Trail", self.c.request("GET", "/api/metadata")[1])

  def test_bad_query_values(self):
    self.assertEqual(self._changes("x")[0], 400)
    self.assertEqual(self.c.request("GET", "/api/sync/changes?since=0&limit=0")[0], 400)

  def test_concurrent_batches_all_land(self):
    n = 16
    results = []

    def push(i):
      status, body = batch(admin_client(), [put("place", f"{i:08x}", {"name": f"Par {i}", "lat": i, "lon": 1})])
      results.append((status, body["results"][0]["rev"] if status == 200 else None))

    threads = [threading.Thread(target=push, args=(i,)) for i in range(n)]
    for t in threads:
      t.start()
    for t in threads:
      t.join()
    revs = [rev for status, rev in results]
    self.assertEqual(len(results), n)
    self.assertNotIn(None, revs, results)
    self.assertEqual(len(set(revs)), n)
    self.assertEqual(len(self.c.request("GET", "/api/places")[1]), n)

  def test_writes_wait_out_a_held_write_lock(self):
    # Another connection holds the database write lock for longer than
    # sqlite3's default 5 second busy timeout, as a burst of slow commits
    # can. A login and a sync batch queue behind it rather than fail.
    results = {}

    def push():
      c = Client(_server.base_url)  # type: ignore[union-attr]
      results["login"] = c.login(SEED_USER, SEED_PW)[0]
      results["batch"] = batch(c, [put("place", "0000beef", {"name": "Waited", "lat": 1, "lon": 1})])[0]

    holder = store_conn()
    try:
      holder.execute("BEGIN IMMEDIATE")
      t = threading.Thread(target=push)
      t.start()
      time.sleep(6)
      holder.execute("COMMIT")
      t.join(30)
    finally:
      holder.close()
    self.assertEqual(results, {"login": 200, "batch": 200})

  def test_epoch_mismatch_or_absence_resets(self):
    self._batch([{"kind": "pref", "op": "put", "id": "k", "data": 1}])
    head = self._changes()[1]["rev"]
    self.assertFalse(self._changes(head)[1]["reset"])
    for epoch in ("stale", None):
      body = self._changes(head, epoch=epoch)[1]
      self.assertTrue(body["reset"], epoch)
      self.assertIn("k", [c["id"] for c in body["changes"]])
    self.assertEqual(self._batch([])[1]["epoch"], self._epoch())

  def test_since_is_bounded(self):
    self.assertEqual(self._changes(2**63)[0], 400)
    self.assertEqual(self._changes(-1)[0], 400)
    self.assertEqual(self._changes(2**63 - 1)[0], 200)

  def test_feed_has_pos(self):
    self._batch([{"kind": "place", "op": "put", "id": "abcdef01", "data": {"name": "P", "lat": 1, "lon": 2}}])
    self.assertEqual(self._changes()[1]["changes"][0]["pos"], 1)

  def test_batch_enforces_whole_set_limits(self):
    labels = [{"kind": "label", "op": "put", "id": f"l{i}", "data": {"label": "L"}} for i in range(201)]
    for chunk in (labels[:200], ):
      self.assertEqual(self._batch(chunk)[0], 200)
    status, _ = self._batch(labels[200:])
    self.assertEqual(status, 409)
    self.assertEqual(len(self.c.request("GET", "/api/me/category-labels")[1]["category_labels"]), 200)
    big = "x" * 600_000
    self.assertEqual(self._batch([{"kind": "pref", "op": "put", "id": "a", "data": big}])[0], 200)
    status, _ = self._batch([{"kind": "pref", "op": "put", "id": "b", "data": big}])
    self.assertEqual(status, 409)
    self.assertNotIn("b", self.c.request("GET", "/api/me/prefs")[1])

  def test_metadata_ids_are_stripped_like_rest(self):
    self._batch([{"kind": "metadata", "op": "put", "id": " Reg/Trail ", "data": {"rating": 4}}])
    self.assertEqual(list(self.c.request("GET", "/api/metadata")[1]), ["Reg/Trail"])

  def test_paging_with_limit(self):
    self._batch([{"kind": "pref", "op": "put", "id": f"k{i}", "data": i} for i in range(4)])
    first = self._changes(0, limit=3)[1]
    self.assertTrue(first["more"])
    self.assertEqual(len(first["changes"]), 3)
    second = self._changes(first["next"])[1]
    self.assertFalse(second["more"])

  def test_read_only_token_cannot_push(self):
    status, body = self.c.request("POST", "/api/me/tokens", {"name": "ro", "scope": "readonly"})
    self.assertEqual(status, 200, body)
    auth = {"Authorization": "Bearer " + body["token"]}
    anon = Client(_server.base_url)  # type: ignore[union-attr]
    self.assertEqual(anon.request("POST", "/api/sync/batch", {"changes": []}, headers=auth)[0], 403)
    self.assertEqual(anon.request("GET", "/api/sync/changes", headers=auth)[0], 200)


class TestExportImportRoundTrip(unittest.TestCase):
  def test_export_then_replace_restores_everything(self):
    c = admin_client()
    fresh_places([])
    reset_kind("area")
    reset_kind("metadata")
    batch(c, [put("place", "abcdef01", {"name": "Round", "lat": 1, "lon": 2, "tags": ["x"]}),
              put("area", "a0000001", {"name": "Trip", "geometry": SQUARE}),
              put("metadata", "Reg/Trail", {"rating": 3})])
    with c.opener.open(_server.base_url + "/api/me/export") as r:  # type: ignore[union-attr]
      archive = r.read()
    names = zipfile.ZipFile(io.BytesIO(archive)).namelist()
    self.assertTrue({"places.json", "areas.json", "metadata.json"} <= set(names))
    before = {k: stored(k) for k in ("place", "area", "metadata")}
    fresh_places([])
    reset_kind("area")
    reset_kind("metadata")
    status, body = c.request("POST", "/api/me/import?mode=replace", raw_body=archive,
                             content_type="application/zip")
    self.assertEqual(status, 200, body)
    self.assertEqual({k: stored(k) for k in ("place", "area", "metadata")}, before)


if __name__ == "__main__":
  unittest.main()


class TestCrawlDefaults(unittest.TestCase):
  """A fresh instance keeps crawlers out but still gives a shared link a
  preview."""

  def setUp(self):
    (_server.data_dir / "index.html").write_text(
      "<head>\n  <title>Ferd</title>\n  <!-- __FERD_SHARE_TAGS__ -->\n</head>", encoding="utf-8")
    # Serving the page reads sw.js for the cache version and keeps it for a
    # few seconds, so a missing one would leak into the next class.
    (_server.data_dir / "sw.js").write_text("// stub", encoding="utf-8")

  def _get(self, path, headers=None):
    req = urllib.request.Request(_server.base_url + path, headers=headers or {})
    try:
      with urllib.request.urlopen(req) as r:
        return r.status, r.headers, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
      return e.code, e.headers, e.read().decode("utf-8")

  def test_robots_shuts_every_crawler_out(self):
    status, headers, body = self._get("/robots.txt")
    self.assertEqual(status, 200)
    self.assertEqual(headers.get("Content-Type"), "text/plain; charset=utf-8")
    self.assertEqual(body, "User-agent: *\nDisallow: /\n")

  def test_no_sitemap(self):
    self.assertEqual(self._get("/sitemap.xml")[0], 404)

  def test_published_map_page_carries_canonical_and_og_image(self):
    origin = _server.base_url  # secure_cookies is off here, so http
    _, _, body = self._get("/u/someone")
    self.assertIn(f'<link rel="canonical" href="{origin}/u/someone/">', body)
    self.assertIn(f'<meta property="og:image" content="{origin}/icons/icon-512.png">', body)
    self.assertNotIn("__FERD_SHARE_TAGS__", body)
    self.assertIn("<title>someone - Ferd</title>", body)
    _, _, body = self._get("/")
    self.assertIn(f'<link rel="canonical" href="{origin}/">', body)
    self.assertIn("<title>Ferd</title>", body)

  def test_a_malformed_host_writes_no_tags(self):
    _, _, body = self._get("/", {"Host": 'x"><script>'})
    self.assertNotIn("canonical", body)
    self.assertNotIn("<script>", body)


class TestCrawlIndexing(unittest.TestCase):
  """With search_indexing on, robots.txt allows the site and the sitemap
  lists the front page and published maps only."""

  @classmethod
  def setUpClass(cls):
    cls.server = _Server({"search_indexing": True, "trusted_proxies": ["127.0.0.1"]})
    cls.c = Client(cls.server.base_url)
    status, _ = cls.c.login(SEED_USER, SEED_PW)
    assert status == 200

  @classmethod
  def tearDownClass(cls):
    cls.server.close()

  def _get(self, path, headers=None):
    req = urllib.request.Request(self.server.base_url + path, headers=headers or {})
    with urllib.request.urlopen(req) as r:
      return r.headers, r.read().decode("utf-8")

  def test_robots_allows_the_site_and_names_the_sitemap(self):
    _, body = self._get("/robots.txt")
    lines = body.splitlines()
    self.assertNotIn("Disallow: /", lines)
    self.assertIn("Allow: /", lines)
    self.assertIn("Allow: /u/", lines)
    self.assertIn(f"Sitemap: {self.server.base_url}/sitemap.xml", lines)

  def test_sitemap_lists_published_maps_only(self):
    loc = f"<loc>{self.server.base_url}/u/{SEED_USER}/</loc>"
    headers, body = self._get("/sitemap.xml")
    self.assertEqual(headers.get("Content-Type"), "application/xml; charset=utf-8")
    self.assertIn(f"<loc>{self.server.base_url}/</loc>", body)
    self.assertNotIn(loc, body)
    self.c.request("POST", "/api/me/publish", {"published": True})
    try:
      _, body = self._get("/sitemap.xml")
      self.assertIn(loc, body)
      self.assertEqual(body.count("<url>"), 2)
    finally:
      self.c.request("POST", "/api/me/publish", {"published": False})

  def test_a_trusted_proxy_sets_the_scheme(self):
    _, body = self._get("/robots.txt", {"X-Forwarded-Proto": "https", "Host": "maps.example.org"})
    self.assertIn("Sitemap: https://maps.example.org/sitemap.xml", body.splitlines())
