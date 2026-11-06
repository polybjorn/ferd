"""How Ferd loads ui.css, and the cascade layer order in index.html.

ui.css is a copy from bjorn/ui-foundation, whose own tests cover the file. Its
blocks only win over the app's general rules while those rules sit in a lower
cascade layer, which these checks keep true.
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


class IndexLayers(unittest.TestCase):
  def test_layer_order_comes_first(self):
    first = next(top_level_statements(head_styles(INDEX)[0]))
    self.assertEqual(first, "@layer ui-tokens, reset, vendor, app, ui;")

  def test_element_resets_sit_below_vendor(self):
    stmts = list(top_level_statements(head_styles(INDEX)[0]))
    reset = next(s for s in stmts if s.startswith("@layer reset {"))
    app = next(s for s in stmts if s.startswith("@layer app {"))
    self.assertIn("*, *::before, *::after", reset)
    self.assertNotIn("*, *::before, *::after", app)
    self.assertNotRegex(app, r"(?m)^\s*a \{")

  def test_old_rules_and_vendor_css_are_layered(self):
    stmts = list(top_level_statements(head_styles(INDEX)[0]))
    for stmt in stmts[1:]:
      self.assertTrue(
        re.match(r'@import url\("/vendor/[^"]+\.css"\) layer\(vendor\);$', stmt)
        or stmt.startswith(("@layer reset {", "@layer app {")),
        "unlayered rule in the main stylesheet: " + stmt[:80])

  def test_no_vendor_stylesheet_links(self):
    head = INDEX.split("</head>", 1)[0]
    links = re.findall(r'<link rel="stylesheet" href="([^"]+)">', head)
    self.assertEqual(links, ["/ui.css?v=__FERD_CACHE_VERSION__"])

  def test_ui_css_loads_after_the_app_rules(self):
    head = INDEX.split("</head>", 1)[0]
    self.assertGreater(head.index('href="/ui.css?'), head.index("} /* @layer app */"))

  def test_only_the_webview_notice_is_unlayered(self):
    styles = head_styles(INDEX)
    self.assertEqual(len(styles), 2)
    for stmt in top_level_statements(styles[1]):
      self.assertTrue(stmt.startswith("#webview-notice"), stmt[:80])

  def test_webview_notice(self):
    self.assertIn('<div id="webview-notice" role="alert" hidden>', INDEX)
    self.assertIn("if (!('CSSLayerBlockRule' in window)) "
                  "document.getElementById('webview-notice').hidden = false;", INDEX)


def relative_luminance(colour):
  channels = [int(colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
  r, g, b = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
  lighter, darker = sorted((relative_luminance(a), relative_luminance(b)), reverse=True)
  return (lighter + 0.05) / (darker + 0.05)


class ThemeContrast(unittest.TestCase):
  """WCAG AA for normal text, the floor docs/architecture.md sets for every theme."""

  def themes(self):
    found = {}
    for selector, body in re.findall(
        r'(:root|\[data-theme="[\w-]+"\]\[data-mode="\w+"\])\s*\{(.*?)\}', INDEX, re.S):
      tokens = dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6})\b", body))
      if "muted" in tokens:
        found[selector] = tokens
    return found

  def test_every_theme_is_measured(self):
    self.assertEqual(len(self.themes()), 15)

  def test_text_and_muted_meet_aa_on_every_surface(self):
    for selector, tokens in self.themes().items():
      for fg in ("text", "muted"):
        for bg in ("bg", "surface", "surface2"):
          ratio = contrast(tokens[fg], tokens[bg])
          self.assertGreaterEqual(ratio, 4.5, "%s %s on %s" % (selector, fg, bg))

  def test_coloured_text_meets_aa_on_every_surface(self):
    self.assertIn("--ui-danger:  var(--danger);", INDEX)
    for selector, tokens in self.themes().items():
      for fg in ("accent", "danger", "green"):
        for bg in ("bg", "surface", "surface2"):
          ratio = contrast(tokens[fg], tokens[bg])
          self.assertGreaterEqual(ratio, 4.5, "%s %s on %s" % (selector, fg, bg))

  def test_status_colours_meet_aa_on_every_surface(self):
    pairs = {mode: dict(re.findall(r"--status-(\w+): (#[0-9a-f]{6})", rule)) for mode, rule in
             re.findall(r'\[data-theme\]\[data-mode="(\w+)"\] \{([^}]*)\}', INDEX)}
    self.assertEqual(sorted(pairs), ["dark", "light"])
    for selector, tokens in self.themes().items():
      pair = pairs["light" if "light" in selector else "dark"]
      self.assertEqual(sorted(pair), ["completed", "planned"])
      for name, colour in pair.items():
        for bg in ("bg", "surface", "surface2"):
          ratio = contrast(colour, tokens[bg])
          self.assertGreaterEqual(ratio, 4.5, "%s %s on %s" % (selector, name, bg))

  def test_only_route_lines_read_the_tile_colours(self):
    self.assertNotRegex(INDEX, r"var\(--(planned|completed)\)")

  def test_text_on_an_accent_fill_meets_aa(self):
    for selector, tokens in self.themes().items():
      for fg in ("fab-text", "bg", "surface"):
        ratio = contrast(tokens[fg], tokens["accent"])
        self.assertGreaterEqual(ratio, 4.5, "%s %s on accent" % (selector, fg))

  def test_control_edge_reaches_3_to_1_on_every_surface(self):
    self.assertIn("--ui-border:  var(--control-border);", INDEX)
    for selector, tokens in self.themes().items():
      for bg in ("bg", "surface", "surface2"):
        ratio = contrast(tokens["control-border"], tokens[bg])
        self.assertGreaterEqual(ratio, 3, "%s control edge on %s" % (selector, bg))

  def test_a_tint_of_a_colour_carries_body_text(self):
    # The colour measured on a surface falls short on a tint of itself.
    for rule in (r"\.modal \.modal-success-box \{", r"\.modal \.user-flag\.on \{",
                 r"\.modal \.danger-btn:not\(h2 \.modal-close\):hover:not\(:disabled\) \{"):
      self.assertRegex(INDEX, rule + r"[^}]*\n\s*color: var\(--text\);")

  def test_settings_hints_use_the_measured_colour(self):
    self.assertRegex(INDEX, r"\.modal \.hint \{[^}]*color: var\(--muted\);")
    self.assertIn('<div class="hint">Visited countries show when zoomed out.</div>', INDEX)

  def test_placeholders_use_the_measured_colour(self):
    self.assertRegex(INDEX, r"\n\s*::placeholder \{ color: var\(--muted\); opacity: 1; \}")
    self.assertRegex(UI_CSS, r"\.ui-field ::placeholder \{\s*color: var\(--ui-muted\);\s*opacity: 1;")


class ControlEdges(unittest.TestCase):
  """--border is for panels and dividers: under 3:1, it cannot mark out a control."""

  CONTROLS = (".view-tabs", ".filter-ms-btn", ".select-option-multi::before", ".group-toggle",
              ".status-chip", ".radio-pills > label", ".radio-segmented", ".feature-pill",
              ".public-maps-item", ".row-src", ".cat-color-dot")

  def rules(self):
    stmts = top_level_statements(head_styles(INDEX)[0])
    app = next(s for s in stmts if s.startswith("@layer app {"))
    return re.findall(r"([^{}]+)\{([^{}]*)\}", app)

  def test_every_control_uses_the_measured_edge(self):
    for selector, body in self.rules():
      if re.search(r"(?:^|[\s;])border:[^;]*var\(--border\)", body):
        named = any(control in selector for control in self.CONTROLS)
        element = re.search(r"(?<![\w-])(input|select|textarea|button)(?![\w-])", selector)
        self.assertFalse(named or element, selector.strip())

  def test_the_named_controls_exist(self):
    selectors = " ".join(selector for selector, _ in self.rules())
    for control in self.CONTROLS:
      self.assertIn(control, selectors)

  def test_hover_is_stronger_than_the_resting_edge(self):
    for selector, body in self.rules():
      if "var(--border-hover)" in body:
        self.assertRegex(selector, r"card|settings-h", selector.strip())


class Labels(unittest.TestCase):
  def test_required_is_marked_instead_of_optional(self):
    self.assertNotIn("(optional", INDEX)
    self.assertIn(".ui-required::after", UI_CSS)


class Shipping(unittest.TestCase):
  def test_precached(self):
    self.assertIn("'/ui.css'", SW)

  def test_android_bundles_the_stylesheet(self):
    gradle = (ROOT / "android" / "app" / "build.gradle.kts").read_text(encoding="utf-8")
    self.assertIn('"ui.css"', gradle)

  def test_service_worker_serves_it_offline(self):
    self.assertIn("url.pathname === '/ui.css'", SW)


class ModalHeight(unittest.TestCase):
  def test_modals_size_to_the_visible_screen(self):
    self.assertNotRegex(INDEX, r"\.modal[^{}]*\{[^{}]*height: calc\(100vh")
    self.assertIn("@supports (height: 100dvh) { .modal-backdrop { --modal-room: 100dvh; } }", INDEX)


class AddForm(unittest.TestCase):
  def test_forms_use_the_blocks_without_inline_styles(self):
    for name, end in (("placeFormHtml", "gpxFormHtml"), ("gpxFormHtml", "wirePlaceForm"),
                      ("areaFormHtml", "searchAreaBoundaries")):
      form = INDEX[INDEX.index("function %s(" % name):INDEX.index("function %s(" % end)]
      self.assertIn("uiFieldHtml(", form)
      self.assertNotIn("style=", form, name)
      self.assertNotIn("settings-toggle", form, name)


if __name__ == "__main__":
  unittest.main()
