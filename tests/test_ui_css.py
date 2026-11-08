"""How Ferd loads ui.css, and the cascade layer order in app/app.css.

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
APP_CSS = (ROOT / "app" / "app.css").read_text(encoding="utf-8")
FRONTEND = "\n".join(p.read_text(encoding="utf-8")
                     for p in [ROOT / "index.html", *sorted((ROOT / "app").rglob("*"))] if p.is_file())
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
    first = next(top_level_statements(APP_CSS))
    self.assertEqual(first, "@layer ui-tokens, reset, vendor, app, ui;")

  def test_element_resets_sit_below_vendor(self):
    stmts = list(top_level_statements(APP_CSS))
    reset = next(s for s in stmts if s.startswith("@layer reset {"))
    app = next(s for s in stmts if s.startswith("@layer app {"))
    self.assertIn("*, *::before, *::after", reset)
    self.assertNotIn("*, *::before, *::after", app)
    self.assertNotRegex(app, r"(?m)^\s*a \{")

  def test_old_rules_and_vendor_css_are_layered(self):
    stmts = list(top_level_statements(APP_CSS))
    for stmt in stmts[1:]:
      self.assertTrue(
        re.match(r'@import url\("/vendor/[^"]+\.css"\) layer\(vendor\);$', stmt)
        or stmt.startswith(("@layer reset {", "@layer app {")),
        "unlayered rule in the main stylesheet: " + stmt[:80])

  def test_no_vendor_stylesheet_links(self):
    head = INDEX.split("</head>", 1)[0]
    links = re.findall(r'<link rel="stylesheet" href="([^"]+)">', head)
    self.assertEqual(links, ["/app/app.css?v=__FERD_CACHE_VERSION__",
                            "/ui.css?v=__FERD_CACHE_VERSION__"])

  def test_ui_css_loads_after_the_app_rules(self):
    head = INDEX.split("</head>", 1)[0]
    self.assertGreater(head.index('href="/ui.css?'), head.index('href="/app/app.css?'))

  def test_only_the_webview_notice_is_unlayered(self):
    styles = head_styles(INDEX)
    self.assertEqual(len(styles), 1)
    for stmt in top_level_statements(styles[0]):
      self.assertTrue(stmt.startswith("#webview-notice"), stmt[:80])

  def test_webview_notice(self):
    self.assertIn('<div id="webview-notice" role="alert" hidden>', INDEX)
    self.assertIn("if (!('CSSLayerBlockRule' in window)) "
                  "document.getElementById('webview-notice').hidden = false;", INDEX)

  def test_status_notices_are_announced(self):
    # The role sits in the shipped markup, hidden and empty, so it is in
    # place before the text changes; a role added along with the text is
    # not announced. The banner that blocks is an alert.
    for el in ('<div id="pwa-offline-banner" class="ui-banner ui-banner-warn pwa-banner" role="status" hidden>',
               '<div id="pwa-sync-issues" class="ui-banner ui-banner-warn pwa-banner" role="alert" hidden>',
               '<div id="pwa-sync-toast" class="ui-toast pwa-toast" role="status" hidden></div>'):
      self.assertIn(el, INDEX)

  def test_update_prompt_is_a_toast_with_an_action(self):
    self.assertIn('<div id="pwa-update-banner" class="ui-toast pwa-toast" role="status" hidden>\n'
                  '    <span id="pwa-update-text"></span>\n'
                  '    <button id="pwa-update-btn" type="button" class="ui-button ui-button-primary">Reload</button>', INDEX)


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
        r'(:root|\[data-theme="[\w-]+"\]\[data-mode="\w+"\])\s*\{(.*?)\}', FRONTEND, re.S):
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
    self.assertIn("--ui-danger:  var(--danger);", FRONTEND)
    for selector, tokens in self.themes().items():
      for fg in ("accent", "danger", "green"):
        for bg in ("bg", "surface", "surface2"):
          ratio = contrast(tokens[fg], tokens[bg])
          self.assertGreaterEqual(ratio, 4.5, "%s %s on %s" % (selector, fg, bg))

  def test_status_colours_reach_3_to_1_on_every_surface(self):
    pairs = {mode: dict(re.findall(r"--status-(\w+): (#[0-9a-f]{6})", rule)) for mode, rule in
             re.findall(r'\[data-theme\]\[data-mode="(\w+)"\] \{([^}]*)\}', FRONTEND)}
    self.assertEqual(sorted(pairs), ["dark", "light"])
    for selector, tokens in self.themes().items():
      pair = pairs["light" if "light" in selector else "dark"]
      self.assertEqual(sorted(pair), ["completed", "planned"])
      for name, colour in pair.items():
        for bg in ("bg", "surface", "surface2"):
          ratio = contrast(colour, tokens[bg])
          self.assertGreaterEqual(ratio, 3, "%s %s on %s" % (selector, name, bg))

  def test_status_colours_never_paint_text(self):
    self.assertNotRegex(FRONTEND, r"(?<![-\w])color:[^;}\n]*--status-")

  def test_place_status_is_fill_not_colour(self):
    for selector in (r"\.dot-visited", r"\.dot-want",
                     r"\.popup-area-item::before", r"\.popup-area-item\.done::before"):
      rule = re.search(selector + r" \{([^}]*)\}", FRONTEND)
      self.assertIsNotNone(rule, selector)
      self.assertIn("var(--text)", rule.group(1), selector)

  def test_routes_in_an_area_list_keep_their_status_colours(self):
    self.assertRegex(FRONTEND, r"\.popup-area-item\.route::before \{[^}]*--status-planned")
    self.assertRegex(FRONTEND, r"\.popup-area-item\.route\.done::before \{[^}]*--status-completed")

  def test_only_route_lines_read_the_tile_colours(self):
    self.assertNotRegex(FRONTEND, r"var\(--(planned|completed)\)")

  def test_text_on_an_accent_fill_meets_aa(self):
    for selector, tokens in self.themes().items():
      for fg in ("fab-text", "bg", "surface"):
        ratio = contrast(tokens[fg], tokens["accent"])
        self.assertGreaterEqual(ratio, 4.5, "%s %s on accent" % (selector, fg))

  def test_control_edge_reaches_3_to_1_on_every_surface(self):
    self.assertIn("--ui-border:  var(--control-border);", FRONTEND)
    for selector, tokens in self.themes().items():
      for bg in ("bg", "surface", "surface2"):
        ratio = contrast(tokens["control-border"], tokens[bg])
        self.assertGreaterEqual(ratio, 3, "%s control edge on %s" % (selector, bg))

  def test_a_tint_of_a_colour_carries_body_text(self):
    # The colour measured on a surface falls short on a tint of itself.
    for rule in (r"\.ui-dialog \.success-box \{", r"\.ui-dialog \.user-flag\.on \{",
                 r"\.ui-dialog \.danger-btn:not\(h2 \.ui-dialog-close\):hover:not\(:disabled\) \{"):
      self.assertRegex(FRONTEND, rule + r"[^}]*\n\s*color: var\(--text\);")

  def test_settings_hints_use_the_measured_colour(self):
    self.assertRegex(FRONTEND, r"\.ui-dialog \.hint \{[^}]*color: var\(--muted\);")
    self.assertIn('<div class="hint">${t(\'settings.general.countriesHint\')}</div>', FRONTEND)

  def test_placeholders_use_the_measured_colour(self):
    self.assertRegex(FRONTEND, r"\n\s*::placeholder \{ color: var\(--muted\); opacity: 1; \}")
    self.assertRegex(UI_CSS, r"\.ui-field ::placeholder \{\s*color: var\(--ui-muted\);\s*opacity: 1;")


class ControlEdges(unittest.TestCase):
  """--border is for panels and dividers: under 3:1, it cannot mark out a control."""

  CONTROLS = (".filter-ms-btn", ".select-option-multi::before", ".feature-pill",
              ".public-maps-item", ".row-src", ".cat-color-dot")

  def rules(self):
    stmts = top_level_statements(APP_CSS)
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

  def test_hover_leaves_a_filled_button_label_alone(self):
    for selector, body in self.rules():
      for part in selector.split(","):
        if ":hover" not in part or ":not(.primary)" in part:
          continue
        if ".primary" in part:
          self.assertNotRegex(body, r"(?:^|[\s;])(?:color|opacity):", part.strip())
        else:
          self.assertNotRegex(part.strip(), r"^\.ui-dialog button:not\(\.ui-dialog-close\):hover")


class TargetsAndFocus(unittest.TestCase):
  """WCAG 2.2 target size minimum, and a focus ring that nothing removes or hides."""

  rules = ControlEdges.rules

  def body(self, wanted):
    return next(body for selector, body in self.rules() if selector.strip() == wanted)

  def test_nothing_removes_the_focus_outline(self):
    for selector, body in self.rules():
      self.assertNotRegex(body, r"(?:^|[\s;])outline:\s*(?:none|0)", selector.strip())

  def test_every_focusable_element_gets_the_ring(self):
    self.assertIn("outline: 2px solid var(--accent)", self.body(":focus-visible"))

  def test_a_filled_control_rings_in_its_label_colour(self):
    selectors = " ".join(s for s, body in self.rules() if "outline-color: currentColor" in body)
    for filled in ("button.primary", "button.nav-action-btn"):
      self.assertIn(filled, selectors)

  def test_a_swatch_ring_sits_outside_its_colour(self):
    body = self.body('button:is(.cat-swatch, .cat-color-dot):focus-visible')
    self.assertIn("outline-offset: 2px", body)

  def test_clipping_panels_leave_room_for_a_ring(self):
    body = self.body("#browse-list, #cat-list")
    self.assertIn("margin-inline: -4px", body)
    self.assertIn("padding-inline: 4px", body)

  def test_a_growing_form_keeps_its_width_when_the_scrollbar_appears(self):
    body = self.body(".ui-dialog .ui-dialog-body:has(#add-body, textarea)")
    self.assertIn("scrollbar-gutter: stable", body)

  def test_the_map_credit_reads_without_a_box(self):
    body = self.body(".leaflet-control-attribution")
    self.assertIn("background: none", body)
    self.assertIn("text-shadow", body)

  def test_the_credit_collapses_only_on_a_phone(self):
    self.assertRegex(FRONTEND, r"max-width: 600px\) \{\s+\.credit-collapsed \.leaflet-control-attribution \{ display: none; \}")

  def test_a_closed_section_takes_no_keyboard_stop(self):
    for closed, opened in ((".cat-swatches", ".cat-swatches.open"),):
      self.assertIn("visibility: hidden", self.body(closed))
      self.assertIn("visibility: visible", self.body(opened))

  def test_buttons_reach_the_minimum_height(self):
    self.assertIn("min-height: 24px", self.body("button"))

  def test_narrow_controls_reach_the_minimum_width(self):
    body = self.body(":is(.ui-dialog-close, .popup-edit, .catalog-mark)")
    self.assertIn("min-width: 24px", body)

  def test_a_button_width_floor_stays_off_flex_items(self):
    self.assertNotIn("min-width", self.body("button"))

  def test_a_toggle_row_is_one_target(self):
    self.assertIn("""'<label class="ui-toggle-row\"""", FRONTEND)
    self.assertNotIn("settings-toggle", FRONTEND)

  def test_the_start_marker_reaches_the_minimum(self):
    self.assertRegex(FRONTEND, r"className: 'marker-start'.*iconSize: \[24, 24\]")

  def test_hidden_file_inputs_leave_the_tab_order(self):
    inputs = re.findall(r"<input[^>]*file-input-hidden[^>]*>", FRONTEND)
    self.assertTrue(inputs)
    for tag in inputs:
      self.assertIn('tabindex="-1"', tag)


class CategoryColours(unittest.TestCase):
  """The palette is chosen to tell categories apart, so it can't carry words."""

  rules = ControlEdges.rules

  def test_no_popup_text_reads_a_category_colour(self):
    for selector, body in self.rules():
      if "popup" in selector:
        self.assertNotRegex(body, r"(?<![\w-])color:\s*var\(--cl?\b", selector.strip())

  def test_the_dot_uses_the_light_palette_in_light_mode(self):
    dots = {" ".join(s.split()): b for s, b in self.rules() if "popup-category-dot" in s}
    self.assertIn("var(--c,", dots[".leaflet-popup-content .popup-category-dot"])
    self.assertIn("var(--cl,", dots['[data-mode="light"] .leaflet-popup-content .popup-category-dot'])


class Labels(unittest.TestCase):
  def test_required_is_marked_instead_of_optional(self):
    self.assertNotIn("(optional", FRONTEND)
    self.assertIn(".ui-required::after", UI_CSS)


class Shipping(unittest.TestCase):
  def test_precached(self):
    self.assertIn("'/ui.css'", SW)

  def test_android_bundles_the_stylesheet(self):
    gradle = (ROOT / "android" / "app" / "build.gradle.kts").read_text(encoding="utf-8")
    self.assertIn('"ui.css"', gradle)

  def test_service_worker_serves_it_offline(self):
    self.assertIn("url.pathname === '/ui.css'", SW)


class NoModalKit(unittest.TestCase):
  # Every dialog is a ui-dialog, so the old modal classes are gone.
  def test_no_rule_selects_a_modal_class(self):
    found = re.findall(r"\.modal(?:-[\w-]+)?\b", strip_comments(APP_CSS))
    self.assertEqual(sorted(set(found)), [])

  def test_no_markup_adds_a_modal_class(self):
    js = FRONTEND.replace(APP_CSS, "")
    self.assertNotRegex(js, r"class(?:Name)?\s*=\s*\$?\{?['\"`][^'\"`]*\bmodal\b(?!-)")
    self.assertNotRegex(js, r"\bmodal-(?!root\b|title\b)[a-z]+\b[^(]")


class MenuScript(unittest.TestCase):
  """ui.js, the menu block's behaviour, ships wherever ui.css does."""

  def test_loaded_deferred_before_the_app(self):
    self.assertIn('<script src="/ui.js?v=__FERD_CACHE_VERSION__" defer></script>', INDEX)
    self.assertLess(INDEX.index('src="/ui.js?'), INDEX.index('src="/app/main.js"'))

  def test_same_release_as_the_stylesheet(self):
    js = (ROOT / "ui.js").read_text(encoding="utf-8")
    self.assertEqual(re.match(r"/\* ui\.js ([0-9.]+):", js).group(1),
                     re.match(r"/\* ui\.css ([0-9.]+):", UI_CSS).group(1))

  def test_precached_and_served_offline(self):
    self.assertIn("'/ui.js'", SW)
    self.assertIn("url.pathname === '/ui.js'", SW)

  def test_android_and_install_bundle_it(self):
    gradle = (ROOT / "android" / "app" / "build.gradle.kts").read_text(encoding="utf-8")
    self.assertIn('"ui.js"', gradle)
    self.assertIn(" ui.js ", (ROOT / "deploy" / "install.sh").read_text(encoding="utf-8"))


class AccountMenu(unittest.TestCase):
  """The wide screen's account menu is a ui.css menu that ui.js drives."""

  AUTH = (ROOT / "app" / "auth.js").read_text(encoding="utf-8")

  def test_menu_button_pattern(self):
    for needle in ('class="ui-menu-anchor"', 'aria-haspopup="menu"', 'aria-controls="auth-menu"',
                   'class="ui-menu ui-menu-end" id="auth-menu" role="menu"', 'class="ui-menu-head"',
                   'role="menuitem"', '<hr class="ui-menu-sep">', "'ui-menu-item-danger'"):
      self.assertIn(needle, self.AUTH)

  def test_no_menu_code_of_its_own(self):
    self.assertNotIn("outsideCloser", self.AUTH)
    self.assertNotIn("_close", self.AUTH)
    actions = (ROOT / "app" / "map" / "map-actions.js").read_text(encoding="utf-8")
    self.assertNotIn("auth-menu", actions)
    self.assertNotRegex(APP_CSS, r"\.auth-menu[\s{.\[]")


class ModalHeight(unittest.TestCase):
  def test_modals_size_to_the_visible_screen(self):
    self.assertNotRegex(FRONTEND, r"\.ui-dialog[^{}]*\{[^{}]*height: calc\(100vh")
    # Insets on the fixed dialog follow the visible screen, where 100vh would
    # count the space behind a phone browser's toolbar.
    # A full-screen view fills the screen instead.
    self.assertRegex(FRONTEND, r"\.ui-dialog:not\(\.ui-dialog-fullscreen\):is\([^{}]*\) \{ inset-block: 3rem; \}")

  def test_a_scrolling_list_keeps_a_floor(self):
    self.assertRegex(FRONTEND, r"#catalog-bulk-list\) \{\s+flex: 1 1 auto;\s+min-height: 4rem")


def view_source(*names):
  return "\n".join((ROOT / "app" / n).read_text(encoding="utf-8") for n in names)


class AddForm(unittest.TestCase):
  def test_forms_use_the_blocks_without_inline_styles(self):
    for name in ("places/add-place.js", "routes/add-route.js", "areas/add-area.js"):
      form = view_source(name)
      self.assertIn("${Field}", form, name)
      self.assertNotIn("style=", form, name)
      self.assertNotIn("settings-toggle", form, name)


class EditForms(unittest.TestCase):
  def test_forms_use_the_blocks_without_inline_styles(self):
    for name in ("places/edit-place.js", "areas/edit-area.js", "routes/route-meta.js"):
      form = view_source(name)
      self.assertIn("${Field}", form, name)
      self.assertNotIn("settings-toggle", form, name)
      self.assertNotIn("<label for=", form, name)

  def test_settings_uses_the_blocks(self):
    view = (ROOT / "app" / "view.js").read_text(encoding="utf-8")
    self.assertIn('class="ui-field"', view)
    self.assertIn('class="ui-toggle-row"', view)
    for name in ("settings.js", "account.js"):
      settings = (ROOT / "app" / "settings" / name).read_text(encoding="utf-8")
      self.assertNotRegex(settings, r"settings-toggle|settings-inline-row|settings-grid-2|<label for=", name)
    settings = (ROOT / "app" / "settings" / "settings.js").read_text(encoding="utf-8")
    self.assertIn("<${Field}", settings)
    self.assertIn("<${Toggle}", settings)

  def test_area_fields_use_the_blocks(self):
    fields = view_source("areas/edit-area.js")
    self.assertNotIn("<label for=", fields)
    self.assertNotIn("style=", fields)


class PopupMeta(unittest.TestCase):
  def test_status_keeps_its_width_beside_the_label(self):
    # At the text floor a 20 character category outgrows Leaflet's 300px popup.
    grid = re.search(r"\.popup-meta \{[^}]*grid-template-columns:\s*([^;]+);", FRONTEND).group(1)
    self.assertEqual(grid, "auto 1fr auto")

  def test_label_wraps_only_past_the_popup_cap(self):
    # A fixed nowrap pushes the status out, and normal wraps before the popup grows.
    rule = re.search(r"\.popup-meta > :first-child \{([^}]*)\}", FRONTEND).group(1)
    self.assertIn("white-space: inherit", rule)
    self.assertNotIn("min-width", rule)


class PhoneWidth(unittest.TestCase):
  """Settings fits a phone: nothing is clipped and the dialog never scrolls sideways."""
  def test_a_segmented_label_can_wrap(self):
    self.assertRegex(UI_CSS, r"\.ui-choice-pills\) > \.ui-choice \{[^}]*overflow-wrap: anywhere")

  def test_settings_tabs_scroll_rather_than_clip(self):
    self.assertRegex(UI_CSS, r"\.ui-tabs \{[^}]*overflow-x: auto")

  def test_token_rows_leave_their_columns_to_the_stylesheet(self):
    self.assertNotIn("grid-template-columns:5rem", FRONTEND)


class TextFloor(unittest.TestCase):
  """Text stays at 0.75rem or above, in a rule or in a style the script builds."""
  FLOOR_REM = 0.75
  SOURCES = FRONTEND + UI_CSS

  def under_floor(self, matches):
    rems = [(float(n) / 16 if unit == "px" else float(n), n + unit) for n, unit in matches]
    return [text for rem, text in rems if rem < self.FLOOR_REM]

  def test_no_literal_font_size_below_it(self):
    found = re.findall(r"font-size\s*:\s*(\d*\.?\d+)(rem|px)", self.SOURCES)
    self.assertTrue(found, "no literal size found, so this check reads nothing")
    self.assertEqual(self.under_floor(found), [])

  def test_no_font_shorthand_below_it(self):
    found = re.findall(r"\bfont\s*[:=]\s*['\"]?[^;'\"\n]*?(\d*\.?\d+)(rem|px)", self.SOURCES)
    self.assertTrue(found, "no shorthand size found, so this check reads nothing")
    self.assertEqual(self.under_floor(found), [])

  def test_no_text_token_below_it(self):
    found = re.findall(r"--ui-text-(?:xs|sm|md|lg|xl)\s*:\s*(\d*\.?\d+)(rem|px)", self.SOURCES)
    self.assertTrue(found, "no text token found, so this check reads nothing")
    self.assertEqual(self.under_floor(found), [])

  def test_no_relative_font_size(self):
    # em and % multiply the parent's size, so they can pass under the floor in a
    # nested element without any one rule saying so.
    self.assertEqual(re.findall(r"font-size\s*:\s*[\d.]+(?:em|%)", self.SOURCES), [])


if __name__ == "__main__":
  unittest.main()


class ModuleLists(unittest.TestCase):
  def test_every_module_is_precached(self):
    # A module left out still works online, then breaks the whole app offline.
    for path in sorted((ROOT / "app").rglob("*")):
      if path.is_file():
        self.assertIn(f"'/app/{path.relative_to(ROOT / 'app')}',", SW)

  def test_every_module_is_preloaded(self):
    # A module left out still works, one network round trip slower per level.
    for path in sorted((ROOT / "app").rglob("*.js")):
      self.assertIn(f'<link rel="modulepreload" href="/app/{path.relative_to(ROOT / "app")}">', INDEX)
