"""Run the configured manifest script for a user and store its route rows."""

from __future__ import annotations

import sqlite3
import subprocess
from pathlib import Path

from . import store
from .common import with_file_lock


def regenerate_manifest(cfg: dict, conn: sqlite3.Connection, uid: int, target_dir: Path) -> dict:
  cmd = cfg.get("manifest_cmd")
  if not cmd:
    return {"ran": False, "reason": "no manifest_cmd configured"}
  # Resolve cmd relative to the *original* data_dir (where the script lives)
  # so that switching cwd to a per-user dir doesn't break the path.
  repo_dir = Path(cfg["data_dir"]).resolve()
  cmd_path = Path(cmd)
  if not cmd_path.is_absolute():
    cmd_path = (repo_dir / cmd).resolve()

  def run_and_ingest():
    proc = subprocess.run(
      [str(cmd_path), str(target_dir)],
      shell=False, check=False, timeout=60, cwd=str(target_dir),
      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    # The script's routes.json is its output, not the store. Reading it back
    # under the same lock keeps two runs from landing in the wrong order.
    if proc.returncode == 0:
      store.ingest_route_manifest(conn, uid, target_dir / "routes.json")
    return proc

  try:
    proc = with_file_lock(target_dir / ".manifest.lock", run_and_ingest)
  except FileNotFoundError:
    return {"ran": False, "reason": f"manifest_cmd not found: {cmd}"}
  except subprocess.TimeoutExpired:
    return {"ran": False, "reason": "manifest_cmd timed out"}
  except sqlite3.Error as e:
    return {"ran": True, "exit_code": 1, "stderr_tail": f"routes not stored: {e}"}
  return {
    "ran": True,
    "exit_code": proc.returncode,
    "stderr_tail": proc.stderr.decode("utf-8", "replace")[-400:],
  }
