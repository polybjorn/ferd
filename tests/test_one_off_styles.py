"""A ratchet on one-off styling in the frontend.

Inline `style=` attributes and `!important` beat every cascade layer, and a
hard-coded colour skips the theme. Each count below is what the frontend holds
today. A change that adds one fails here: use a ui.css block, a class in
`@layer app` or a theme token instead. A change that removes some fails too,
until the number below is lowered to match, so the slack can't be spent again.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_CSS = (ROOT / "app" / "app.css").read_text(encoding="utf-8")
FRONTEND = "\n".join(p.read_text(encoding="utf-8")
                     for p in [ROOT / "index.html", *sorted((ROOT / "app").iterdir())])

# Lower these as one-off styles move out. Never raise them.
MAX_INLINE_STYLES = 73
MAX_IMPORTANT = 71
MAX_HARDCODED_COLOURS = 12

COLOUR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(")
# A theme block defines tokens, so its literals are the theme itself.
THEME_SELECTOR = re.compile(r"^(?::root|\[data-theme[^{]*\])\s*$")


def declaration_blocks(css):
  """Yield (selector, body) for every innermost `{...}` block of `css`."""
  stack = []
  for i, ch in enumerate(css):
    if ch == "{":
      stack.append([i, False])
    elif ch == "}":
      start, has_child = stack.pop()
      if stack:
        stack[-1][1] = True
      if not has_child:
        prelude_start = max(css.rfind("{", 0, start), css.rfind("}", 0, start), css.rfind(";", 0, start)) + 1
        yield css[prelude_start:start].strip(), css[start + 1:i]


def count_hardcoded_colours(css):
  return sum(
    len(COLOUR.findall(body))
    for selector, body in declaration_blocks(css)
    if not THEME_SELECTOR.match(selector)
  )


def count_inline_styles(html):
  return len(re.findall(r"(?<![\w-])style=", html))


def count_important(html):
  return html.count("!important")


class OneOffStyles(unittest.TestCase):
  def check(self, name, count, ceiling):
    self.assertLessEqual(
      count, ceiling,
      f"the frontend now has {count} {name}, over the ceiling of {ceiling}. "
      "Use a ui.css block, a class in @layer app or a theme token instead.")
    self.assertEqual(
      count, ceiling,
      f"the frontend is down to {count} {name}. Lower the ceiling in "
      f"tests/test_one_off_styles.py from {ceiling} to {count}.")

  def test_inline_styles(self):
    self.check("inline style= attributes", count_inline_styles(FRONTEND), MAX_INLINE_STYLES)

  def test_important(self):
    self.check("!important declarations", count_important(FRONTEND), MAX_IMPORTANT)

  def test_hardcoded_colours(self):
    self.check("hard-coded colours outside the theme blocks",
               count_hardcoded_colours(re.sub(r"/\*.*?\*/", "", APP_CSS, flags=re.S)), MAX_HARDCODED_COLOURS)


class Counting(unittest.TestCase):
  def test_theme_blocks_and_selectors_are_not_colours(self):
    css = """
      :root { --bg: #2e3440; --shadow: rgba(0, 0, 0, 0.4); }
      @layer app {
        [data-theme="nord"][data-mode="dark"] { --bg: #2e3440; }
        #add .row { color: #fff; box-shadow: 0 1px rgba(0,0,0,.2); }
        .x { color: var(--text); }
      }
    """
    self.assertEqual(count_hardcoded_colours(css), 2)

  def test_data_style_is_not_inline_style(self):
    self.assertEqual(count_inline_styles('<a style="x" data-style="y">'), 1)


if __name__ == "__main__":
  unittest.main()
