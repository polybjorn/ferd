"""Server bootstrap: argument parsing, startup wiring and the listen loop."""

from __future__ import annotations

import argparse
import http.server
import os
import socket
import sys
import threading
import time
from pathlib import Path

from .auth import RATE_LIMIT_MAX_FAILS, RATE_LIMIT_WINDOW, RateLimiter, new_setup_token
from .config import load_config, parse_trusted_proxies
from .db import db_connect, db_init, db_migrate
from .places import backfill_country_codes
from .users import ensure_user_dir, seed_initial_user, user_count
from .handler import Handler


class ThreadingHTTPServer(http.server.ThreadingHTTPServer):
  daemon_threads = True
  allow_reuse_address = True
  # socketserver listens with a backlog of 5, so a burst of connections (a
  # client syncing after time offline, a page load fetching in parallel) could
  # be reset before a worker thread picked it up. The kernel caps this at
  # net.core.somaxconn.
  request_queue_size = 128


def parse_bind(spec: str) -> tuple[str, int]:
  host, _, port = spec.rpartition(":")
  return host or "127.0.0.1", int(port)


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--config", default="tools/config.json", type=Path)
  args = parser.parse_args()

  cfg = load_config(args.config)
  conn = db_connect(cfg["db_path"])
  db_init(conn)
  db_migrate(conn)
  seed_initial_user(conn, cfg)
  for r in conn.execute("SELECT id, username FROM users").fetchall():
    name = r["username"]
    try:
      ensure_user_dir(cfg, name)
      n = backfill_country_codes(conn, r["id"])
      if n:
        print(f"[api] set country_code on {n} places for {name}", file=sys.stderr)
    except Exception as e:  # one user's trouble must not stop the server for the others
      print(f"[api] startup work for {name} skipped: {type(e).__name__}: {e}", file=sys.stderr)
  # Setup token: if enabled and no users exist yet, generate one and require it
  # on /api/register. Print to stderr only; the admin copies it from logs.
  # Must run before conn.close() below - user_count needs the boot connection.
  Handler.setup_token = None
  if cfg.get("require_setup_token") and user_count(conn) == 0:
    Handler.setup_token = new_setup_token()

  # Boot conn is done with; handlers open per-request connections.
  conn.close()

  Handler.cfg = cfg
  Handler.trusted_proxies = parse_trusted_proxies(cfg.get("trusted_proxies"))
  Handler.login_limiter = RateLimiter(RATE_LIMIT_MAX_FAILS, RATE_LIMIT_WINDOW)
  Handler.write_lock = threading.Lock()
  Handler.last_request = time.monotonic()

  idle_threshold = int(cfg.get("idle_exit_seconds") or 0)
  if idle_threshold > 0:
    def _idle_watcher():
      poll = max(15, min(idle_threshold, 60))
      while True:
        time.sleep(poll)
        if time.monotonic() - Handler.last_request >= idle_threshold:
          print(f"[api] idle for {idle_threshold}s, exiting", file=sys.stderr)
          os._exit(0)
    threading.Thread(target=_idle_watcher, name="idle-watcher", daemon=True).start()

  host, port = parse_bind(cfg["bind"])

  # Honor systemd socket activation if present (LISTEN_FDS=1 means fd 3 is our socket).
  listen_fds = int(os.environ.get("LISTEN_FDS", "0") or "0")
  if listen_fds:
    sock = socket.socket(fileno=3)
    server = ThreadingHTTPServer((host, port), Handler, bind_and_activate=False)
    server.socket = sock
    server.server_address = sock.getsockname()
    print("[api] inherited socket fd 3 from systemd", file=sys.stderr)
  else:
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[api] listening on {host}:{port}", file=sys.stderr)

  try:
    server.serve_forever()
  except KeyboardInterrupt:
    print("[api] shutting down", file=sys.stderr)
  finally:
    server.server_close()
  return 0
