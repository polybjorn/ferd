#!/usr/bin/env python3
"""Ferd's API on loopback with demo data, for the modal review sheet.

    python3 .site-sheet/serve.py [PORT]

Starts tools/api.py in a fresh temporary directory, seeds the admin the
states file signs in as, adds places, an area and a route so the edit and
catalog modals have something to open, prints the origin and serves until
killed. The seeding runs against a private port and that API is stopped
before one starts on PORT over the same db and data dir, so a caller that
waits for PORT to answer never sees it unseeded.
Capture from it with:

    site-sheet capture "" / OUT --states .site-sheet/states.json --origin http://127.0.0.1:PORT
"""

import json
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
USER, PASSWORD = "demo", "demo-password-1"

GPX = b"""<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ferd-demo" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>Ridge loop</name><trkseg>
<trkpt lat="59.500" lon="6.500"><ele>100</ele></trkpt>
<trkpt lat="59.505" lon="6.510"><ele>180</ele></trkpt>
<trkpt lat="59.510" lon="6.505"><ele>240</ele></trkpt>
<trkpt lat="59.504" lon="6.495"><ele>150</ele></trkpt>
</trkseg></trk></gpx>
"""


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8097
    tmp = Path(tempfile.mkdtemp(prefix="ferd-sheet-"))
    static = tmp / "static"
    shutil.copytree(REPO, static, ignore=shutil.ignore_patterns(
        ".git", ".site-sheet", "android", "tests", "tools", "users", "data", "*.db*"))
    shutil.copy(REPO / "site-config.example.json", static / "site-config.json")
    settings = {
        "db_path": str(tmp / "app.db"),
        "data_dir": str(tmp / "data"),
        "static_dir": str(static),
        "manifest_cmd": str(REPO / "scripts" / "gpx-manifest.sh"),
        "initial_user": USER,
        "initial_password": PASSWORD,
        "secure_cookies": False,
    }
    api = None
    try:
        seeding = free_port()
        api = start(tmp, settings, seeding)
        seed("http://127.0.0.1:%d" % seeding)
        api.terminate()
        api.wait(timeout=10)
        api = start(tmp, settings, port)
        origin = "http://127.0.0.1:%d" % port
        wait_for(origin)
        print(origin, flush=True)
        signal.signal(signal.SIGTERM, lambda *_: api.terminate())
        api.wait()
    finally:
        if api:
            api.terminate()
        shutil.rmtree(tmp, ignore_errors=True)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(tmp, settings, port):
    config = tmp / "config.json"
    config.write_text(json.dumps(dict(settings, bind="127.0.0.1:%d" % port)))
    return subprocess.Popen([sys.executable, str(REPO / "tools" / "api.py"), "--config", str(config)],
                            stdin=subprocess.DEVNULL)


def wait_for(origin):
    for _ in range(100):
        try:
            urllib.request.urlopen(origin + "/api/health", timeout=1).read()
            return
        except OSError:
            time.sleep(0.1)
    sys.exit("serve.py: the API did not answer on %s" % origin)


def seed(origin):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def call(method, path, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        req = urllib.request.Request(origin + path, data=data, method=method,
                                     headers={"Content-Type": ctype})
        return opener.open(req, timeout=10).read()

    wait_for(origin)
    call("POST", "/api/login", {"username": USER, "password": PASSWORD})
    call("POST", "/api/places", {"name": "Old boathouse", "lat": 59.52, "lon": 6.48,
                                 "category": "boathouse"})
    # Imported from the shipped catalog with a note that has since changed
    # there, so the catalog update modals have an update to show.
    call("POST", "/api/places", {"name": "Abu Simbel", "lat": 22.3369, "lon": 31.6256,
                                 "from_catalog": "Abu Simbel", "note": "Temples"})
    call("POST", "/api/areas", {"name": "Birch grove", "geometry": {"type": "Polygon", "coordinates": [
        [[6.52, 59.49], [6.54, 59.49], [6.54, 59.50], [6.52, 59.50], [6.52, 59.49]]]}})
    call("POST", "/api/gpx?region=Demo&name=Ridge%20loop", GPX, "application/gpx+xml")


if __name__ == "__main__":
    main()
