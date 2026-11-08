"""No HTML string sinks in the frontend's own code.

The app renders through Preact and the DOM, so nothing in app/ parses a
string as markup. That is the code-side precondition for a CSP with
`require-trusted-types-for 'script'`. Leaflet and the vendored libraries
still write markup themselves and sit outside app/.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SINKS = re.compile(r"\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write(?:ln)?|escapeHtml)\b")


class TestNoHtmlSinks(unittest.TestCase):
  def test_app_has_no_html_sinks(self):
    hits = [
      "%s:%d: %s" % (p.relative_to(ROOT).as_posix(), n, line.strip())
      for p in sorted((ROOT / "app").rglob("*")) if p.is_file()
      for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
      if SINKS.search(line)
    ]
    self.assertEqual(hits, [], "build DOM nodes or a view instead")

  def test_pattern_catches_each_sink(self):
    for line in ("el.innerHTML = s", "el.outerHTML = s", "el.insertAdjacentHTML('afterbegin', s)",
                 "document.write(s)", "document.writeln(s)", "escapeHtml(s)"):
      self.assertRegex(line, SINKS)


if __name__ == "__main__":
  unittest.main()
