"""Hold the API's JSON responses to the client's JSDoc typedefs.

Each row of `api_contract.ENDPOINTS` names the typedef the client reads an
endpoint's body as. This test calls every one of them against a live server
and fails on a key the typedef does not declare, a required property the
handler did not send, or a value of the wrong type.

Run with: python3 -m unittest discover -s tests
"""

from __future__ import annotations

import json
import sys
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import api_contract  # noqa: E402
from api_contract import ENDPOINTS, NOT_READ, Registry, check_body, literal_api_calls  # noqa: E402
from test_api_integration import GPX_BODY, SEED_PW, SEED_USER, Client, _Server  # noqa: E402

SHIPPED = [{"name": "Shipped Peak", "lat": 61.5, "lon": 8.3, "category": "peak", "country": "Norway"}]
MANIFEST_CMD = Path(__file__).resolve().parent.parent / "scripts" / "gpx-manifest.sh"
POLYGON = {"type": "Polygon", "coordinates": [[[10.0, 59.0], [10.1, 59.0], [10.1, 59.1], [10.0, 59.0]]]}


def _write_catalog(data_dir: Path) -> None:
  (data_dir / "catalog.json").write_text(json.dumps(SHIPPED))


class TestApiContract(unittest.TestCase):
  """Every JSON body the client reads matches its typedef."""

  @classmethod
  def setUpClass(cls) -> None:
    # The route manifest is what scripts/gpx-manifest.sh writes, so run it.
    cls.server = _Server({"manifest_cmd": str(MANIFEST_CMD)}, prepare=_write_catalog)
    cls.bodies = cls._collect(cls.server.base_url)

  @classmethod
  def tearDownClass(cls) -> None:
    cls.server.close()

  @classmethod
  def _collect(cls, base: str) -> dict[tuple[str, str], object]:
    """One response body per ENDPOINTS row, from a server holding at least
    one of everything a list can carry."""
    bodies: dict[tuple[str, str], object] = {}

    def keep(method, path, status, body, want=(200,)):
      assert status in want, f"{method} {path}: {status} {body}"
      bodies[(method, path)] = body

    admin = Client(base)
    keep("POST", "/login", *admin.request("POST", "/api/login", {"username": SEED_USER, "password": SEED_PW, "token": True}))
    bearer = {"Authorization": "Bearer " + bodies[("POST", "/login")]["session_token"]}

    def call(method, path, body=None, **kw):
      return admin.request(method, "/api" + path, body, headers=bearer, **kw)

    anon = Client(base)
    keep("GET", "/health", *anon.request("GET", "/api/health"))
    keep("GET", "/state", *anon.request("GET", "/api/state"))

    keep("POST", "/sync/batch", *call("POST", "/sync/batch", {"changes": [
      {"kind": "place", "op": "put", "id": "a1b2c3d4", "data": {
        "name": "Contract Place", "lat": 59.9, "lon": 10.7, "category": "peak", "country": "Norway",
        "visited": True, "note": "n", "tags": ["t"], "date_visited": "2026-01-02", "rating": 4}},
      {"kind": "area", "op": "put", "id": "e5f6a7b8", "data": {"name": "Contract Area", "geometry": POLYGON, "category": "park"}},
      {"kind": "label", "op": "put", "id": "peak", "data": {"label": "Peaks", "color": 2, "order": 0}},
      {"kind": "pref", "op": "put", "id": "theme", "data": "dark"},
    ]}))
    status, _ = call("POST", "/gpx?region=Contract&name=route-a", raw_body=GPX_BODY, content_type="application/gpx+xml")
    assert status == 201, status
    status, err = call("POST", "/sync/batch", {"changes": [{"kind": "metadata", "op": "put", "id": "Contract/route-a", "data": {
      "source": "https://example.org/r", "date_completed": "2026-02-03", "rating": 3, "notes": "n", "tags": ["t"], "difficulty": "hard", "local_name": "l"}}]})
    assert status == 200, (status, err)
    keep("GET", "/sync/changes", *call("GET", "/sync/changes?since=0&limit=5000"))

    keep("POST", "/me/tokens", *call("POST", "/me/tokens", {"name": "contract", "scope": "readonly", "expires_in_days": 30}))
    keep("GET", "/me/tokens", *call("GET", "/me/tokens"))
    keep("GET", "/sessions", *call("GET", "/sessions"))

    status, export = cls._raw(base, "/api/me/export", bearer)
    assert status == 200, status
    keep("POST", "/me/import", *call("POST", "/me/import?mode=merge", raw_body=export, content_type="application/zip"))

    keep("POST", "/admin/catalog/add", *call("POST", "/admin/catalog/add", {"entries": [
      {"name": "Local Lake", "lat": 60.1, "lon": 9.2, "category": "lake"}]}))
    status, _ = call("POST", "/admin/catalog/hide", {"name": SHIPPED[0]["name"], "hidden": True})
    assert status == 200, status
    keep("GET", "/catalog?include_hidden=1", *call("GET", "/catalog?include_hidden=1"))
    status, _ = call("POST", "/admin/catalog/hide", {"name": SHIPPED[0]["name"], "hidden": False})
    assert status == 200, status
    keep("GET", "/catalog", *call("GET", "/catalog"))

    status, _ = call("POST", "/settings/registration", {"mode": "open"})
    assert status == 200, status
    keep("POST", "/register", *anon.request("POST", "/api/register", {"username": "contract2", "password": "contract-pw-1234", "token": True}), want=(201,))

    keep("GET", "/admin/stats", *call("GET", "/admin/stats"))
    keep("GET", "/admin/users", *call("GET", "/admin/users"))
    keep("GET", "/admin/logs", *call("GET", "/admin/logs?limit=100"))

    status, _ = call("POST", "/me/publish", {"published": True})
    assert status == 200, status
    keep("GET", "/public-maps", *anon.request("GET", "/api/public-maps"))
    for kind in ("places", "areas", "routes", "category-labels"):
      keep("GET", f"/u/<name>/{kind}", *anon.request("GET", f"/api/u/{SEED_USER}/{kind}"))
    return bodies

  @staticmethod
  def _raw(base: str, path: str, headers: dict[str, str]):
    req = urllib.request.Request(base + path, headers=headers)
    with urllib.request.urlopen(req) as r:
      return r.status, r.read()

  def test_every_response_matches_its_typedef(self):
    reg = Registry()
    for method, path, rel, name, where in ENDPOINTS:
      with self.subTest(endpoint=f"{method} {path}", typedef=name):
        self.assertIn((method, path), self.bodies, "no response collected for this row")
        errs, count = check_body(reg, rel, name, where, self.bodies[(method, path)])
        self.assertEqual(errs, [], f"{method} {path} against {name} in {rel}")
        self.assertGreater(count, 0, "an empty list checks nothing; seed one")

  def test_every_read_endpoint_has_a_row(self):
    """A literal api() call in app/ is either a row or listed as not read."""
    rows = {(m, p.split("?", 1)[0]) for m, p, *_ in ENDPOINTS}
    for method, path in sorted(literal_api_calls()):
      if path.endswith("/") or "<" in path:
        known = any(m == method and r.startswith(path) for m, r in rows | NOT_READ)
      else:
        known = (method, path) in rows | NOT_READ
      with self.subTest(call=f"{method} {path}"):
        self.assertTrue(known, "add a row to ENDPOINTS in tests/api_contract.py, or to NOT_READ if the client ignores the body")


class TestContractChecker(unittest.TestCase):
  """The checker itself, on typedefs written here rather than read from app/."""

  def check(self, typ: str, value):
    return Registry().check("app/core.js", api_contract._Parser(typ).parse(), value)

  def test_types(self):
    self.assertEqual(self.check("string", "x"), [])
    self.assertNotEqual(self.check("number", "12"), [])
    self.assertNotEqual(self.check("number", True), [])
    self.assertEqual(self.check("string | null", None), [])
    self.assertNotEqual(self.check("string", None), [])
    self.assertEqual(self.check("Array<number>", [1, 2.5]), [])
    self.assertNotEqual(self.check("number[]", [1, "2"]), [])
    self.assertEqual(self.check("Object<string, boolean>", {"a": True}), [])
    self.assertEqual(self.check("'a' | 'b'", "b"), [])
    self.assertNotEqual(self.check("'a' | 'b'", "c"), [])
    self.assertEqual(self.check("() => void", 3), [])

  def test_objects(self):
    t = "{ a: string, b?: number }"
    self.assertEqual(self.check(t, {"a": "x"}), [])
    self.assertNotEqual(self.check(t, {}), [], "missing required key")
    self.assertNotEqual(self.check(t, {"a": "x", "c": 1}), [], "undeclared key")
    self.assertNotEqual(self.check(t, {"a": "x", "b": None}), [], "null for a non-nullable optional")
    self.assertEqual(self.check("Place & { _x?: boolean }", {"name": "n", "lat": 1, "lon": 2, "_x": True}), [])

  def test_property_tags(self):
    reg = Registry()
    rel, t = reg.lookup("app/core.js", "AuthState")
    self.assertNotEqual(reg.check(rel, t, {"authenticated": True, "username": "u"}), [], "is_admin is required")


if __name__ == "__main__":
  unittest.main()
