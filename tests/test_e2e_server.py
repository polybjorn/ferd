"""tests/e2e/server.py stops promptly on SIGTERM.

scripts/lighthouse-ci.sh and Playwright both stop the e2e server with SIGTERM
and wait for it. Its handler once ran while the main thread held Popen's
waitpid lock, so it could not reap the API and sat out a 5 s kill fallback.
"""
import os
import signal
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


class E2EServerStopTest(unittest.TestCase):
  def test_sigterm_stops_server_and_api_quickly(self):
    proc = subprocess.Popen(
      [sys.executable, str(REPO / "tests" / "e2e" / "server.py")],
      cwd=REPO, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
      stderr=subprocess.DEVNULL, text=True,
    )
    try:
      line = proc.stdout.readline()
      self.assertTrue(line.startswith("ferd-e2e ready on port "), line)
      port = int(line.rsplit(" ", 1)[1])
      start = time.monotonic()
      proc.send_signal(signal.SIGTERM)
      proc.wait(timeout=10)
      self.assertLess(time.monotonic() - start, 2)
      self.assertEqual(proc.returncode, 0)
      with self.assertRaises(OSError):
        socket.create_connection(("127.0.0.1", port), timeout=1).close()
    finally:
      if proc.poll() is None:
        proc.kill()
        proc.wait()
      proc.stdout.close()


if __name__ == "__main__":
  unittest.main()
