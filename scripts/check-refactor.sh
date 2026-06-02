#!/usr/bin/env bash
# Refactor-signal scan: textual duplication (jscpd) + Python complexity (radon).
#
# These are cheap, deterministic tripwires that NARROW where to look. They do
# NOT find semantic duplication ("same behavior, different code"), dead code, or
# judge whether a refactor is worth doing - that stays with judgment. Treat the
# output as a signal to investigate, not a number to drive to zero; some
# duplication is intentional. Running debt list lives in .refactor-notes.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# Versions are pinned in scripts/vendor-versions.json (single source of truth,
# watched weekly by check-vendor-versions.py), read here so they never drift.
eval "$(python3 - <<'PY'
import json
t = {x["name"]: x["version"] for x in json.load(open("scripts/vendor-versions.json"))["tools"]}
print(f'JSCPD_VERSION={t["jscpd"]}')
print(f'RADON_VERSION={t["radon"]}')
PY
)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# index.html is one giant inline <script>; jscpd picks parsers by extension, so
# without this it tokenizes the file as HTML and misses the JS duplication we
# care about. Extract the script to a real .js, padded with leading blank lines
# so its line numbers map 1:1 back to index.html.
python3 - "$TMP/index.inline.js" <<'PY'
import re, sys
html = open('index.html', encoding='utf-8').read()
m = re.search(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S)
pad = html[:m.start(1)].count('\n')   # blank lines so content starts on its real line
open(sys.argv[1], 'w', encoding='utf-8').write('\n' * pad + m.group(1))
PY
cp tools/api.py "$TMP/api.py"

echo "== Duplication (jscpd $JSCPD_VERSION) =="
echo "   (index.inline.js line N == index.html line N)"
# Defaults skip files >100KB / >1000 lines; ours blow past both, so raise them.
# Rewrite the temp paths back to the real files and drop jscpd's promo banner.
npx -y "jscpd@$JSCPD_VERSION" \
  --min-tokens 60 --max-size 5mb --max-lines 50000 \
  -p "**/*.{js,py}" --reporters console "$TMP" 2>&1 \
  | sed -E "s#[^ ]*/index\.inline\.js#index.html#g; s#[^ ]*/api\.py#tools/api.py#g" \
  | grep -vE "Auto-refactor with AI|Gangsta|Support jscpd|opencollective" || true

echo
echo "== Python complexity (radon, tools/) =="
if python3 -c "import radon" 2>/dev/null; then
  echo "-- cyclomatic complexity, blocks ranked C or worse --"
  python3 -m radon cc tools/ -s -n C
  echo "-- maintainability index, files ranked B or worse --"
  python3 -m radon mi tools/ -s -n B
else
  echo "radon not installed; run: pip install radon==$RADON_VERSION"
fi
