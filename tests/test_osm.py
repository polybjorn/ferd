"""Route import from OpenStreetMap relations: chaining, simplification, the
GPX it writes, and the two endpoints against a stub Overpass server."""

from __future__ import annotations

import json
import sys
import threading
import unittest
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ferd_api import ValidationError, gpx_lines, validate_gpx  # noqa: E402
from ferd_api import osm  # noqa: E402


def _way(*pts, role=""):
  return {"type": "way", "ref": 0, "role": role, "geometry": [{"lat": a, "lon": b} for a, b in pts]}


# A superroute (1) of two stages (2, 3), one with a variant that must be left
# out, and the second stage's way stored backwards.
STUB_ANSWER = {"elements": [
  {"type": "relation", "id": 1, "members": [
    {"type": "relation", "ref": 2, "role": ""},
    {"type": "relation", "ref": 3, "role": ""},
    {"type": "node", "ref": 9, "role": "guidepost", "lat": 0, "lon": 0},
  ], "tags": {"name": "Stub Way"}},
  {"type": "relation", "id": 2, "members": [
    _way((60.0, 10.0), (60.001, 10.0), (60.002, 10.0)),
    _way((60.002, 10.0), (60.5, 11.0), role="alternative"),
  ]},
  {"type": "relation", "id": 3, "members": [
    _way((60.004, 10.0), (60.003, 10.0), (60.002, 10.0)),
  ]},
]}

STUB_ENTRY = {"name": "Stub Way", "relation": 1, "country": "Norway"}


class StubOverpass:
  """An Overpass stand-in on a free port that answers STUB_ANSWER and
  records the queries it was sent."""

  def __init__(self, answer=STUB_ANSWER, status=200):
    queries = self.queries = []

    class H(BaseHTTPRequestHandler):
      def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        queries.append(parse_qs(self.rfile.read(n).decode())["data"][0])
        body = json.dumps(answer).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

      def log_message(self, *a):
        pass

    self.httpd = HTTPServer(("127.0.0.1", 0), H)
    self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/api/interpreter"
    threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

  def close(self):
    self.httpd.shutdown()
    self.httpd.server_close()


class ChainTests(unittest.TestCase):
  def test_joins_in_order_and_flips_reversed_ways(self):
    a, b, c, d = (0, 0), (0, 1), (0, 2), (0, 3)
    self.assertEqual(osm.chain_ways([[a, b], [c, b], [c, d]]), [[a, b, c, d]])

  def test_flips_a_first_way_stored_backwards(self):
    a, b, c = (0, 0), (0, 1), (0, 2)
    self.assertEqual(osm.chain_ways([[b, a], [b, c]]), [[a, b, c]])

  def test_gap_starts_a_new_line(self):
    a, b, c, d = (0, 0), (0, 1), (5, 5), (5, 6)
    self.assertEqual(osm.chain_ways([[a, b], [c, d]]), [[a, b], [c, d]])

  def test_relation_lines_expands_children_and_skips_roles(self):
    lines = osm.relation_lines(STUB_ANSWER, 1)
    self.assertEqual(lines, [[(60.0, 10.0), (60.001, 10.0), (60.002, 10.0), (60.003, 10.0), (60.004, 10.0)]])

  def test_missing_or_empty_relation(self):
    with self.assertRaises(ValidationError):
      osm.relation_lines(STUB_ANSWER, 99)
    with self.assertRaises(ValidationError):
      osm.relation_lines({"elements": [{"type": "relation", "id": 5, "members": []}]}, 5)


class SimplifyTests(unittest.TestCase):
  def test_drops_collinear_points_keeps_corners(self):
    line = [(60.0, 10.0 + i * 0.0001) for i in range(50)] + [(60.01, 10.0049)]
    out = osm.simplify(line, 5)
    self.assertEqual(out, [line[0], line[49], line[50]])

  def test_keeps_a_bend_above_tolerance(self):
    # 0.001 deg of latitude is about 110 m off the straight line.
    line = [(60.0, 10.0), (60.001, 10.01), (60.0, 10.02)]
    self.assertEqual(osm.simplify(line, 50), line)
    self.assertEqual(osm.simplify(line, 200), [line[0], line[2]])

  def test_fit_raises_tolerance_until_under_the_cap(self):
    # A zigzag with 20 m teeth: 5 m keeps every point, 40 m keeps the ends.
    line = [(60.0 + (i % 2) * 0.00018, 10.0 + i * 0.001) for i in range(400)]
    out, tol = osm.simplify_to_fit([line], max_points=100)
    self.assertLessEqual(sum(map(len, out)), 100)
    self.assertGreater(tol, osm.SIMPLIFY_START_M)
    out, tol = osm.simplify_to_fit([line], max_points=1000)
    self.assertEqual((len(out[0]), tol), (400, osm.SIMPLIFY_START_M))


class GpxTests(unittest.TestCase):
  def test_gpx_carries_the_osm_credit_and_parses(self):
    line = [(60.0, 10.0), (60.1, 10.1)]
    raw = osm.build_gpx("Stub <&> Way", 42, [line, line])
    validate_gpx(raw)
    self.assertEqual(gpx_lines(raw), [[[10.0, 60.0], [10.1, 60.1]]] * 2)
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    root = ET.fromstring(raw)
    cr = root.find("g:metadata/g:copyright", ns)
    self.assertEqual(cr.get("author"), "OpenStreetMap contributors")
    self.assertEqual(cr.find("g:license", ns).text, osm.ODBL_URL)
    self.assertEqual(root.find("g:metadata/g:link", ns).get("href"), "https://www.openstreetmap.org/relation/42")
    self.assertEqual(root.find("g:trk/g:name", ns).text, "Stub <&> Way")

  def test_import_route_uses_the_fetcher(self):
    seen = []
    out = osm.import_route(STUB_ENTRY, fetch=lambda rel: seen.append(rel) or STUB_ANSWER)
    self.assertEqual(seen, [1])
    self.assertEqual((out["segments"], out["source"]), (1, "https://www.openstreetmap.org/relation/1"))
    self.assertEqual(sum(map(len, gpx_lines(out["gpx"].encode()))), out["points"])


class FetchTests(unittest.TestCase):
  def test_http_error_is_a_validation_error(self):
    stub = StubOverpass(status=504)
    try:
      with self.assertRaises(ValidationError):
        osm.fetch_overpass(1, stub.url)
    finally:
      stub.close()

  def test_query_names_the_relation(self):
    stub = StubOverpass()
    try:
      self.assertEqual(osm.fetch_overpass(1, stub.url), STUB_ANSWER)
      self.assertIn("relation(1)", stub.queries[0])
    finally:
      stub.close()


class EndpointTests(unittest.TestCase):
  @classmethod
  def setUpClass(cls):
    from test_api_integration import SEED_PW, SEED_USER, Client, _Server
    cls.stub = StubOverpass()

    def prepare(d):
      (d / "catalog-routes.json").write_text(json.dumps([STUB_ENTRY]))

    cls.server = _Server({"overpass_url": cls.stub.url}, prepare=prepare)
    cls.off = _Server({"overpass_url": ""}, prepare=prepare)
    cls.c = Client(cls.server.base_url)
    cls.c.login(SEED_USER, SEED_PW)
    cls.c_off = Client(cls.off.base_url)
    cls.c_off.login(SEED_USER, SEED_PW)
    cls.anon = Client(cls.server.base_url)

  @classmethod
  def tearDownClass(cls):
    cls.server.close()
    cls.off.close()
    cls.stub.close()

  def test_list(self):
    self.assertEqual(self.c.request("GET", "/api/catalog/routes"), (200, {"entries": [STUB_ENTRY], "importable": True}))
    self.assertEqual(self.c_off.request("GET", "/api/catalog/routes"), (200, {"entries": [STUB_ENTRY], "importable": False}))
    self.assertEqual(self.anon.request("GET", "/api/catalog/routes")[0], 401)

  def test_gpx(self):
    status, body = self.c.request("POST", "/api/catalog/routes/gpx", {"relation": 1})
    self.assertEqual(status, 200, body)
    self.assertEqual(body["points"], len(gpx_lines(body["gpx"].encode())[0]))
    self.assertIn("OpenStreetMap contributors", body["gpx"])

  def test_gpx_refuses_what_is_not_in_the_catalog(self):
    before = len(self.stub.queries)
    for rel in (2, "1", None):
      with self.subTest(relation=rel):
        self.assertEqual(self.c.request("POST", "/api/catalog/routes/gpx", {"relation": rel})[0], 404)
    self.assertEqual(len(self.stub.queries), before, "nothing outside the catalog reaches Overpass")

  def test_gpx_off_and_signed_out(self):
    self.assertEqual(self.c_off.request("POST", "/api/catalog/routes/gpx", {"relation": 1})[0], 404)
    self.assertEqual(self.anon.request("POST", "/api/catalog/routes/gpx", {"relation": 1})[0], 401)


if __name__ == "__main__":
  unittest.main()
