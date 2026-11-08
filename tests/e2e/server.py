#!/usr/bin/env python3
"""Start a throwaway Ferd server for the browser tests.

Playwright's webServer runs this. It makes a temporary directory, writes a
config that keeps the database and every user folder inside it, starts
tools/api.py on a free loopback port, then signs in as the seeded user and
imports the demo dataset from scripts/demo-data.py. A run never touches real
data, and the directory is removed when Playwright stops the server.

Once the data is in, it prints "ferd-e2e ready on port N" to stdout.
playwright.config.js waits for that line and reads the port out of it, so the
tests never start against a server that is still empty.

Usage: python3 tests/e2e/server.py [PORT]

Stdlib only. The sign-in the tests use is E2E_USER / E2E_PASSWORD below,
mirrored in tests/e2e/smoke.spec.js.
"""
import json
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
E2E_USER = "demo"
E2E_PASSWORD = "demo-password-1"


def free_port() -> int:
  with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    s.bind(("127.0.0.1", 0))
    return s.getsockname()[1]


def wait_healthy(base: str, proc: subprocess.Popen, timeout: float = 30) -> None:
  deadline = time.monotonic() + timeout
  while time.monotonic() < deadline:
    if proc.poll() is not None:
      raise SystemExit(f"[e2e] api.py exited with {proc.returncode}")
    try:
      with urllib.request.urlopen(base + "/api/health", timeout=2) as r:
        if r.status == 200:
          return
    except (urllib.error.URLError, OSError):
      pass
    time.sleep(0.2)
  raise SystemExit("[e2e] api.py did not answer /api/health in time")


def seed(base: str, zip_path: Path) -> None:
  opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
  login = urllib.request.Request(
    base + "/api/login",
    data=json.dumps({"username": E2E_USER, "password": E2E_PASSWORD}).encode(),
    headers={"Content-Type": "application/json"},
  )
  opener.open(login, timeout=10).close()
  imp = urllib.request.Request(
    base + "/api/me/import?mode=replace",
    data=zip_path.read_bytes(),
    headers={"Content-Type": "application/zip"},
  )
  with opener.open(imp, timeout=30) as r:
    print("[e2e] imported demo data:", r.read().decode()[:200], file=sys.stderr)


def main() -> int:
  port = int(sys.argv[1]) if len(sys.argv) > 1 else free_port()
  tmp = Path(tempfile.mkdtemp(prefix="ferd-e2e-"))
  proc = None

  def stop(*_):
    if proc and proc.poll() is None:
      proc.terminate()
      try:
        proc.wait(timeout=5)
      except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(0)

  signal.signal(signal.SIGTERM, stop)
  signal.signal(signal.SIGINT, stop)
  try:
    config = {
      "bind": f"127.0.0.1:{port}",
      "db_path": str(tmp / "app.db"),
      "data_dir": str(tmp),
      "static_dir": str(REPO),
      "manifest_cmd": str(REPO / "scripts" / "gpx-manifest.sh"),
      "initial_user": E2E_USER,
      "initial_password": E2E_PASSWORD,
      "secure_cookies": False,
    }
    (tmp / "config.json").write_text(json.dumps(config))
    zip_path = tmp / "demo.zip"
    subprocess.run(
      [sys.executable, str(REPO / "scripts" / "demo-data.py"), "-o", str(zip_path)],
      check=True, stdin=subprocess.DEVNULL,
    )
    proc = subprocess.Popen(
      [sys.executable, str(REPO / "tools" / "api.py"), "--config", str(tmp / "config.json")],
      cwd=REPO, stdin=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    wait_healthy(base, proc)
    seed(base, zip_path)
    print(f"ferd-e2e ready on port {port}", flush=True)
    proc.wait()
    return proc.returncode or 0
  finally:
    stop()


if __name__ == "__main__":
  sys.exit(main())
