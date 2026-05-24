#!/usr/bin/env python3
"""Check vendored deps against the latest version on npm.

Reads scripts/vendor-versions.json, queries the npm registry for each
package's `latest` dist-tag, and prints a report. Exits 1 if any vendored
version is behind upstream, 0 if all match. Designed for CI: a non-zero
exit triggers the workflow to open an issue with the drift report.

Stdlib only.
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

REGISTRY = "https://registry.npmjs.org"
MANIFEST = Path(__file__).parent / "vendor-versions.json"


def fetch_latest(pkg: str) -> str:
    url = f"{REGISTRY}/{pkg}/latest"
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{pkg}: HTTP {e.code}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"{pkg}: {e.reason}") from e
    v = data.get("version")
    if not v:
        raise RuntimeError(f"{pkg}: no version in registry response")
    return v


def main() -> int:
    manifest = json.loads(MANIFEST.read_text())
    drift = []
    errors = []
    rows = []
    for dep in manifest["deps"]:
        name = dep["npm"]
        current = dep["version"]
        try:
            latest = fetch_latest(name)
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

    print("All vendored deps are at the latest version.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
