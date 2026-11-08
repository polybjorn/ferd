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
                     for p in [ROOT / "index.html", *sorted((ROOT / "app").rglob("*"))] if p.is_file())
SCRIPTS = {p.relative_to(ROOT).as_posix(): p.read_text(encoding="utf-8")
           for p in [ROOT / "ui.js", *sorted((ROOT / "app").rglob("*.js"))]}

# Lower these as one-off styles move out. Never raise them.
MAX_INLINE_STYLES = 65
MAX_IMPORTANT = 71
MAX_HARDCODED_COLOURS = 7
# style= in markup built as a string. Keep this at zero: the CSP's style-src
# has no 'unsafe-inline', so the browser drops these.
MAX_STRING_BUILT_STYLES = 0

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


def string_literals(js):
  """Yield the text of every quoted string in `js`, and of every template
  literal not tagged html (an htm template, which Preact turns into DOM calls
  that set style through the CSSOM). Comments and regex literals are skipped,
  and the expressions inside a template are scanned as code."""
  out = []
  _scan(js, 0, out, None)
  return out


def _scan(js, i, out, closer):
  """Scan code from `i` until `closer` ("}" ending a template expression, or
  None for the end of `js`), appending string texts to `out`. Returns the index
  after the closer."""
  depth = 0
  prev = ""  # the last significant character, to tell a regex from a division
  word = ""  # the identifier or keyword ending at i
  n = len(js)
  while i < n:
    c = js[i]
    if js.startswith("//", i):
      i = js.find("\n", i)
      i = n if i < 0 else i
      continue
    if js.startswith("/*", i):
      i = js.index("*/", i + 2) + 2
      continue
    if c in "'\"":
      j = i + 1
      while js[j] != c:
        j += 2 if js[j] == "\\" else 1
      out.append(js[i + 1:j])
      i, prev, word = j + 1, c, ""
      continue
    if c == "`":
      tag = re.search(r"([\w$]*)\s*$", js[max(0, i - 40):i]).group(1)
      i = _template(js, i + 1, out, tag in ("html", "vhtml"))
      prev, word = "`", ""
      continue
    if c == "/" and (not prev or prev in "(,=:[!&|?{};+-*%<>~^") :
      j = i + 1
      in_class = False
      while js[j] != "/" or in_class:
        if js[j] == "\\":
          j += 1
        elif js[j] == "[":
          in_class = True
        elif js[j] == "]":
          in_class = False
        j += 1
      i, prev, word = j + 1, "/", ""
      continue
    if c == "{":
      depth += 1
    elif c == "}":
      if depth == 0 and closer == "}":
        return i + 1
      depth -= 1
    if c.isalnum() or c in "_$":
      word += c
      # `return /x/` is a regex; `a / b` is a division.
      prev = "(" if word in ("return", "typeof", "case") else "a"
    else:
      word = ""
      if not c.isspace():
        prev = "a" if c in ")]" else c
    i += 1
  return i


def _template(js, i, out, tagged):
  text = []
  while js[i] != "`":
    if js[i] == "\\":
      text.append(js[i:i + 2])
      i += 2
    elif js.startswith("${", i):
      i = _scan(js, i + 2, out, "}")
    else:
      text.append(js[i])
      i += 1
  if not tagged:
    out.append("".join(text))
  return i + 1


def count_string_built_styles(sources):
  """style= attributes in markup a script builds as a string. Those go in
  through innerHTML and are the inline styles a CSP without 'unsafe-inline'
  in style-src blocks; an htm template's style= is set through the CSSOM."""
  return sum(count_inline_styles(s) for js in sources for s in string_literals(js))


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

  def test_string_built_styles(self):
    for name, js in SCRIPTS.items():
      self.assertEqual(count_string_built_styles([js]), 0,
                       f"{name} builds a style= attribute into a markup string, which the CSP's "
                       "style-src blocks. Use a class in @layer app, or set it through el.style.")
    self.check("style= attributes in string-built markup",
               count_string_built_styles(SCRIPTS.values()), MAX_STRING_BUILT_STYLES)

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

  def test_string_built_style_is_found_and_templates_are_not(self):
    js = r"""
      // a comment with '<b style="x">' in it
      const a = '<em style="color:red">' + x;
      const b = "<i style='y'>";
      const re = /'/g, half = n / 2;
      const c = `<u style="z">${'<s style="w">'}</u>`;
      const d = html`<div style="display:flex" title=${t('k')}>${'<p>'}</div>`;
      const e = vhtml`<span style=${'background:' + c}></span>`;
      return /"/.test(s) ? '<q style="v">' : '';
    """
    self.assertEqual(count_string_built_styles([js]), 5)

  def test_data_style_is_not_inline_style(self):
    self.assertEqual(count_inline_styles('<a style="x" data-style="y">'), 1)


if __name__ == "__main__":
  unittest.main()
