#!/usr/bin/env python3
"""API server entry point.

Stdlib-only. Provides auth (register/login/logout/change-password/state) and
per-user data endpoints (places, GPX routes, prefs, publish toggle, export)
backed by SQLite for accounts and a per-user folder for content. The code
lives in the ferd_api package beside this file.

Run: python3 tools/api.py [--config tools/config.json]
"""

import sys

# Python puts this script's directory first on sys.path, so ferd_api resolves
# from any working directory.
from ferd_api import main

if __name__ == "__main__":
  sys.exit(main())
