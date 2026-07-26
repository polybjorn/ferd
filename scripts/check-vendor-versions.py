#!/usr/bin/env python3
"""Check pinned versions against the latest published upstream.

Reads scripts/vendor-versions.json: 'deps' are vendored frontend libs (npm),
'tools' are dev-only CLI tools (npm or pypi per 'source'). Queries each
registry for the latest version and prints a report.

Exit codes, which the CI workflow branches on: 0 every pin matches upstream
(close any open tracking issue), 1 something is behind (open or update the
issue with the report), 2 at least one registry lookup failed so the state is
unknown (fail the run and leave the issue alone). 2 matters because an empty
drift list after a failed lookup is not evidence of being in sync.

Stdlib only.
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

REGISTRY = "https://registry.npmjs.org"
MANIFEST = Path(__file__).parent / "vendor-versions.json"


def _get_json(url: str, label: str):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{label}: HTTP {e.code}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"{label}: {e.reason}") from e


def fetch_latest(pkg: str, source: str = "npm") -> str:
    if source == "pypi":
        v = _get_json(f"https://pypi.org/pypi/{pkg}/json", pkg).get("info", {}).get("version")
    else:
        v = _get_json(f"{REGISTRY}/{pkg}/latest", pkg).get("version")
    if not v:
        raise RuntimeError(f"{pkg}: no version in registry response")
    return v


def main() -> int:
    manifest = json.loads(MANIFEST.read_text())
    # Normalize deps (npm) and tools (npm|pypi) into one (name, source, version) list.
    items = [(d["npm"], "npm", d["version"]) for d in manifest["deps"]]
    items += [(t["name"], t["source"], t["version"]) for t in manifest.get("tools", [])]
    drift = []
    errors = []
    rows = []
    for name, source, current in items:
        try:
            latest = fetch_latest(name, source)
        except RuntimeError as e:
            errors.append(str(e))
            rows.append((name, current, "ERROR"))
            continue
        rows.append((name, current, latest))
        if latest != current:
            drift.append((name, current, latest))

    name_w = max(len(r[0]) for r in rows)
    cur_w = max(len(r[1]) for r in rows)
    for name, current, latest in rows:
        marker = " <- bump" if latest != current and latest != "ERROR" else ""
        print(f"{name:<{name_w}}  {current:>{cur_w}}  ->  {latest}{marker}")

    print()
    if errors:
        print("Errors:")
        for e in errors:
            print(f"  {e}")
        print()

    if drift:
        print(f"Drift detected for {len(drift)} package(s):")
        for name, current, latest in drift:
            print(f"  - {name}: {current} -> {latest}")
        return 1

    if errors:
        print("Version state is unknown: the lookups above failed, so nothing "
              "here says the pins are in sync.")
        return 2

    print("All vendored deps are at the latest version.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
