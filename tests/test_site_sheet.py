"""The modal review sheet's states file and the demo server it is captured from.

The capture itself needs chromium, so it runs by hand (see CONTRIBUTING.md);
what runs here is the file's shape, as site-sheet checks it before
a capture, and the demo data the states click through to.
"""

import http.cookiejar
import json
import re
import socket
import subprocess
import sys
import time
import unittest
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SHEET = REPO / ".site-sheet"
ACTIONS = ("click", "fill", "press", "wait")
# Keys a step may carry beside its action, as site-sheet allows them.
EXTRAS = {"click": {"button"}, "fill": {"value"}}
BUTTONS = ("left", "right", "middle")


def free_port():
  with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    return s.getsockname()[1]


class TestStatesFile(unittest.TestCase):
  def test_states_load_the_way_site_sheet_loads_them(self):
    states = json.loads((SHEET / "states.json").read_text())
    self.assertIsInstance(states, list)
    seen = set()
    for st in states:
      self.assertRegex(st["name"], r"^[A-Za-z0-9._-]+$")
      self.assertNotIn((st["page"], st["name"]), seen)
      seen.add((st["page"], st["name"]))
      # The sign-in modal opens only from a public map, where nobody is signed in.
      self.assertIn(st["page"], ("index.html", "u/demo/"))
      self.assertTrue(st["steps"])
      for step in st["steps"]:
        acts = [k for k in step if k in ACTIONS]
        self.assertEqual(len(acts), 1, step)
        self.assertEqual(set(step) - {acts[0]} - EXTRAS.get(acts[0], set()), set(), step)
        self.assertEqual("value" in step, acts[0] == "fill", step)
        self.assertIn(step.get("button", "left"), BUTTONS, step)

  def test_every_modal_title_has_a_state(self):
    """A new modalHeaderHtml('Title') with no state waiting on it fails here."""
    html = (REPO / "index.html").read_text()
    titles = set(re.findall(r"modalHeaderHtml\('([^'(]+)", html))
    titles |= set(re.findall(r'id="modal-title">([^<\']+)', html))
    states = (SHEET / "states.json").read_text()
    missing = {t for t in titles if 'has-text(\\"%s' % t.strip() not in states}
    self.assertEqual(missing, set())


class TestDemoServer(unittest.TestCase):
  def test_seeds_what_the_states_open(self):
    port = free_port()
    proc = subprocess.Popen([sys.executable, str(SHEET / "serve.py"), str(port)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    try:
      origin = proc.stdout.readline().strip()
      self.assertEqual(origin, "http://127.0.0.1:%d" % port)
      opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

      def get(path, body=None):
        req = urllib.request.Request(origin + path, data=body and json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        return json.loads(opener.open(req, timeout=10).read())

      get("/api/login", {"username": "demo", "password": "demo-password-1"})
      places = {p["name"]: p for p in get("/api/places")}
      self.assertEqual(places["Abu Simbel"]["from_catalog"], "Abu Simbel")
      self.assertEqual(places["Old boathouse"]["category"], "boathouse")
      self.assertEqual([a["name"] for a in get("/api/areas")], ["Birch grove"])
      regions = get("/api/routes")["regions"]
      self.assertEqual([r["name"] for r in regions], ["Demo"])
      with urllib.request.urlopen(origin + "/site-config.json", timeout=10) as r:
        self.assertEqual(r.status, 200)
    finally:
      proc.terminate()
      proc.wait(timeout=10)

  def test_port_answers_only_once_seeded(self):
    """A capture that starts as soon as the port answers
    must not race the seed."""
    port = free_port()
    origin = "http://127.0.0.1:%d" % port
    proc = subprocess.Popen([sys.executable, str(SHEET / "serve.py"), str(port)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    try:
      for _ in range(3000):
        try:
          urllib.request.urlopen(origin + "/api/health", timeout=1).read()
          break
        except OSError:
          time.sleep(0.005)
      else:
        self.fail("serve.py never answered on %s" % origin)
      opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
      req = urllib.request.Request(origin + "/api/login", headers={"Content-Type": "application/json"},
                                   data=json.dumps({"username": "demo", "password": "demo-password-1"}).encode())
      opener.open(req, timeout=10).read()
      with opener.open(origin + "/api/routes", timeout=10) as r:
        self.assertEqual([g["name"] for g in json.loads(r.read())["regions"]], ["Demo"])
    finally:
      proc.terminate()
      proc.wait(timeout=10)


if __name__ == "__main__":
  unittest.main()
