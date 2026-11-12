#!/usr/bin/env bash
# Holds the sign-in page and a published map at 100 on Lighthouse
# accessibility, best practices and SEO, on phone and desktop. Starts the e2e
# stack (tests/e2e/server.py) with the demo data and the demo map published,
# runs site-audit over / and /u/demo, and grades the Lighthouse scores alone
# with scripts/lighthouse-gate.js.
#
# SITE_AUDIT names site-audit.mjs, as ci-actions' site-audit/fetch.sh exports
# it; locally it falls back to a `site-audit` command on PATH. RUNS sets the
# Lighthouse runs per page (default 1). The report is left in
# e2e-logs/site-audit.json beside the API log.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
mkdir -p e2e-logs
report=e2e-logs/site-audit.json
rm -f "$report"

if [ -n "${SITE_AUDIT:-}" ]; then audit=(node "$SITE_AUDIT")
elif command -v site-audit >/dev/null; then audit=(site-audit)
else
  echo "lighthouse-ci: set SITE_AUDIT to site-audit.mjs, or put site-audit on PATH" >&2
  exit 2
fi

# A real install seeds site-config.json (deploy/install.sh, the Dockerfile);
# without it the page's fetch of it 404s and costs best practices 4 points.
made_config=
if [ ! -f site-config.json ]; then
  cp site-config.example.json site-config.json
  made_config=1
fi

out=$(mktemp)
# Its stderr is the API log, kept in e2e-logs/api.log as well. Search
# indexing is on, because a default instance's robots.txt shuts crawlers out on
# purpose and Lighthouse counts that against SEO; the score held here is the
# one for an instance that wants its published maps found.
FERD_SEARCH_INDEXING=1 python3 tests/e2e/server.py --publish >"$out" 2>e2e-logs/server.err </dev/null &
server=$!
cleanup() {
  kill "$server" 2>/dev/null || true
  wait "$server" 2>/dev/null || true
  rm -f "$out"
  [ -z "$made_config" ] || rm -f site-config.json
}
trap cleanup EXIT

port=
for _ in $(seq 300); do
  port=$(sed -n 's/^ferd-e2e ready on port \([0-9]*\)$/\1/p' "$out")
  [ -n "$port" ] && break
  kill -0 "$server" 2>/dev/null || { tail -20 e2e-logs/server.err >&2; echo "lighthouse-ci: the e2e server exited before it was ready" >&2; exit 1; }
  sleep 0.2
done
[ -n "$port" ] || { echo "lighthouse-ci: the e2e server was not ready in 60 s" >&2; exit 1; }

base="http://127.0.0.1:$port/"
# site-audit exits 1 on any finding, and some of its findings are not this
# gate's to hold; the gate reads the report instead.
"${audit[@]}" --lighthouse --runs "${RUNS:-1}" --json "$report" "$base" / /u/demo || true
[ -f "$report" ] || { echo "lighthouse-ci: site-audit wrote no report" >&2; exit 1; }
node scripts/lighthouse-gate.js "$report" "$base" "${base}u/demo"
