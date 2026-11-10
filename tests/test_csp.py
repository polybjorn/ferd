"""The Content-Security-Policy value, its mode switch and the report parser."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "tools"))

from ferd_api import csp  # noqa: E402


class TestPolicy(unittest.TestCase):
  def test_default_is_report_only(self):
    self.assertEqual(csp.header_name({}), "Content-Security-Policy-Report-Only")
    self.assertEqual(csp.header_name({"FERD_CSP_MODE": "nonsense"}),
                     "Content-Security-Policy-Report-Only")

  def test_enforce(self):
    self.assertEqual(csp.header_name({"FERD_CSP_MODE": "enforce"}), "Content-Security-Policy")

  def test_default_policy_takes_the_hash_and_reports(self):
    value = csp.policy("'sha256-abc'", {})
    self.assertIn("script-src 'self' 'sha256-abc';", value)
    self.assertNotIn("{importmap}", value)
    self.assertTrue(value.endswith("; report-uri /api/csp-report; report-to csp"))

  def test_override_keeps_its_own_report_directives(self):
    env = {"FERD_CSP": "default-src 'self'; script-src 'self' {importmap}; report-uri https://r.example/"}
    value = csp.policy("'sha256-abc'", env)
    self.assertEqual(value, "default-src 'self'; script-src 'self' 'sha256-abc'; report-uri https://r.example/")

  def test_the_shipped_index_has_an_import_map_to_hash(self):
    html = (REPO_ROOT / "index.html").read_bytes()
    self.assertRegex(csp.importmap_hash(html), r"^'sha256-[A-Za-z0-9+/]{43}='$")
    # Only the import map is inline; any other inline script needs its own hash.
    self.assertEqual(html.count(b"<script>"), 0)


  def test_android_shell_matches_the_server_policy(self):
    kt = (REPO_ROOT / "android/app/src/main/java/io/github/polybjorn/ferd/ContentSecurityPolicy.kt").read_text()
    block = re.search(r"private const val POLICY =(.*?)\n\n", kt, re.S).group(1)
    android = "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', block))
    expected = csp.DEFAULT_POLICY.replace("connect-src 'self' https:;", "connect-src 'self' https: http:;")
    self.assertEqual(android, expected)


class TestShellNeedsNoInline(unittest.TestCase):
  """What the shell ships has to fit the default policy with no 'unsafe-inline'."""

  INDEX = (REPO_ROOT / "index.html").read_text(encoding="utf-8")
  SCRIPTS = [REPO_ROOT / "ui.js", REPO_ROOT / "theme-init.js", REPO_ROOT / "webview-check.js",
             *sorted((REPO_ROOT / "app").rglob("*.js"))]

  def test_style_src_is_self(self):
    self.assertIn("style-src 'self';", csp.DEFAULT_POLICY)
    self.assertNotIn("'unsafe-inline'", csp.DEFAULT_POLICY)
    self.assertNotIn("'unsafe-eval'", csp.DEFAULT_POLICY)

  def test_served_policy_allows_the_shipped_import_map(self):
    # Hashed here independently of csp.importmap_hash, so a change to the
    # tag that its pattern no longer matches fails rather than serving no hash.
    text = self.INDEX.split('<script type="importmap">', 1)[1].split("</script>", 1)[0]
    digest = base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii")
    value = csp.policy(csp.importmap_hash((REPO_ROOT / "index.html").read_bytes()), {})
    self.assertIn(f"script-src 'self' 'sha256-{digest}';", value)

  def test_no_inline_script_but_the_import_map(self):
    inline = re.findall(r"<script(?![^>]*\bsrc=)([^>]*)>", self.INDEX)
    self.assertEqual(inline, [' type="importmap"'])

  def test_no_event_handler_attribute(self):
    self.assertNotRegex(self.INDEX, r"<[a-zA-Z][^<>]*\son[a-z]+\s*=")

  def test_no_javascript_url(self):
    for f in [REPO_ROOT / "index.html", *self.SCRIPTS]:
      self.assertNotRegex(f.read_text(encoding="utf-8"), r"(?i)javascript:", f.name)

  def test_no_style_element(self):
    self.assertNotIn("<style", self.INDEX)
    for f in self.SCRIPTS:
      self.assertNotRegex(f.read_text(encoding="utf-8"), r"createElement\(\s*['\"]style['\"]", f.name)


class TestParseReports(unittest.TestCase):
  def test_legacy_shape(self):
    raw = json.dumps({"csp-report": {"blocked-uri": "inline", "violated-directive": "script-src",
                                     "source-file": "https://x/", "line-number": 3}}).encode()
    self.assertEqual(csp.parse_reports(raw, "application/csp-report"),
                     [{"blocked": "inline", "directive": "script-src", "source": "https://x/", "line": "3"}])

  def test_reporting_api_shape_skips_other_types(self):
    raw = json.dumps([
      {"type": "deprecation", "body": {}},
      {"type": "csp-violation", "body": {"blockedURL": "eval", "effectiveDirective": "script-src"}},
    ]).encode()
    out = csp.parse_reports(raw, "application/reports+json")
    self.assertEqual([r["blocked"] for r in out], ["eval"])

  def test_webkit_sends_one_reporting_api_entry_as_csp_report(self):
    raw = json.dumps({"type": "csp-violation", "url": "https://ferd.example/", "body": {
      "documentURL": "https://ferd.example/", "disposition": "report",
      "effectiveDirective": "style-src-elem", "blockedURL": "inline",
      "statusCode": 200, "sample": ""}}).encode()
    out = csp.parse_reports(raw, "application/csp-report")
    self.assertEqual([(r["directive"], r["blocked"]) for r in out], [("style-src-elem", "inline")])

  def test_csp_report_without_either_shape_is_refused(self):
    for body in ({}, {"type": "intervention", "body": {}}, {"type": "csp-violation"}, []):
      with self.assertRaises(ValueError):
        csp.parse_reports(json.dumps(body).encode(), "application/csp-report")

  def test_fields_are_cleaned_and_truncated(self):
    raw = json.dumps({"csp-report": {"blocked-uri": "a\nb" + "x" * 500}}).encode()
    blocked = csp.parse_reports(raw, "application/csp-report")[0]["blocked"]
    self.assertTrue(blocked.startswith("a?b"))
    self.assertEqual(len(blocked), csp.REPORT_FIELD_MAX)

  def test_refuses_other_types(self):
    with self.assertRaises(ValueError):
      csp.parse_reports(b"{}", "application/json")


if __name__ == "__main__":
  unittest.main()
