"""ui.css contract and the cascade layer order in index.html.

ui.css is meant to be shared with other apps, so it must stay free of Ferd
names, and its blocks only win over the app's general rules while those rules
sit in a lower cascade layer. These checks keep both true.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI_CSS = (ROOT / "ui.css").read_text(encoding="utf-8")
INDEX = (ROOT / "index.html").read_text(encoding="utf-8")
SW = (ROOT / "sw.js").read_text(encoding="utf-8")


def strip_comments(css):
  return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def head_styles(html):
  head = html.split("</head>", 1)[0]
  return re.findall(r"<style>(.*?)</style>", head, flags=re.S)


def top_level_statements(css):
  """Yield each top-level rule or at-rule of `css`, comments removed."""
  css = strip_comments(css)
  depth, start = 0, 0
  for i, ch in enumerate(css):
    if ch == "{":
      depth += 1
    elif ch == "}":
      depth -= 1
      if depth == 0:
        yield css[start:i + 1].strip()
        start = i + 1
    elif ch == ";" and depth == 0:
      yield css[start:i + 1].strip()
      start = i + 1
  tail = css[start:].strip()
  if tail:
    yield tail


class UiCssContract(unittest.TestCase):
  def test_no_app_specific_names(self):
    self.assertNotRegex(UI_CSS.lower(), r"ferd")
    for name in ("--surface)", "--accent)", "--text)", "--muted)", ".modal"):
      self.assertNotIn(name, UI_CSS)

  def test_every_class_is_prefixed(self):
    classes = set(re.findall(r"\.([a-zA-Z_][\w-]*)", strip_comments(UI_CSS)))
    self.assertTrue(classes)
    self.assertEqual({c for c in classes if not c.startswith("ui-")}, set())

  def test_every_rule_is_layered(self):
    for stmt in top_level_statements(UI_CSS):
      self.assertRegex(stmt, r"^@layer ui(-tokens)? \{", stmt[:60])

  def test_custom_properties_are_prefixed(self):
    props = set(re.findall(r"(--[\w-]+)\s*:", strip_comments(UI_CSS)))
    self.assertTrue(props)
    self.assertEqual({p for p in props if not p.startswith("--ui-")}, set())

  def test_precached(self):
    self.assertIn("'/ui.css'", SW)


class IndexLayers(unittest.TestCase):
  def test_layer_order_comes_first(self):
    first = next(top_level_statements(head_styles(INDEX)[0]))
    self.assertEqual(first, "@layer ui-tokens, vendor, app, ui;")

  def test_old_rules_and_vendor_css_are_layered(self):
    stmts = list(top_level_statements(head_styles(INDEX)[0]))
    for stmt in stmts[1:]:
      self.assertTrue(
        re.match(r'@import url\("/vendor/[^"]+\.css"\) layer\(vendor\);$', stmt)
        or stmt.startswith("@layer app {"),
        "unlayered rule in the main stylesheet: " + stmt[:80])

  def test_no_vendor_stylesheet_links(self):
    head = INDEX.split("</head>", 1)[0]
    links = re.findall(r'<link rel="stylesheet" href="([^"]+)">', head)
    self.assertEqual(links, ["/ui.css"])

  def test_ui_css_loads_after_the_app_rules(self):
    head = INDEX.split("</head>", 1)[0]
    self.assertGreater(head.index('href="/ui.css"'), head.index("} /* @layer app */"))

  def test_only_the_webview_notice_is_unlayered(self):
    styles = head_styles(INDEX)
    self.assertEqual(len(styles), 2)
    for stmt in top_level_statements(styles[1]):
      self.assertTrue(stmt.startswith("#webview-notice"), stmt[:80])

  def test_webview_notice(self):
    self.assertIn('<div id="webview-notice" role="alert" hidden>', INDEX)
    self.assertIn("if (!('CSSLayerBlockRule' in window)) "
                  "document.getElementById('webview-notice').hidden = false;", INDEX)


if __name__ == "__main__":
  unittest.main()
