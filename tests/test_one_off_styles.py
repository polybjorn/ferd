"""No style= in markup a script builds as a string.

The counts of inline `style=`, `!important` and literal colours are
ui-foundation's one_off_check.py, run from CI with Ferd's limits. What stays
here is Ferd's own rule: the CSP's style-src has no 'unsafe-inline', so a
style= written into a markup string is dropped by the browser.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = {p.relative_to(ROOT).as_posix(): p.read_text(encoding="utf-8")
           for p in [ROOT / "ui.js", *sorted((ROOT / "app").rglob("*.js"))]}



def count_inline_styles(html):
  return len(re.findall(r"(?<![\w-])style=", html))


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


class StringBuiltStyles(unittest.TestCase):
  def test_string_built_styles(self):
    for name, js in SCRIPTS.items():
      self.assertEqual(count_string_built_styles([js]), 0,
                       f"{name} builds a style= attribute into a markup string, which the CSP's "
                       "style-src blocks. Use a class in @layer app, or set it through el.style.")


class Counting(unittest.TestCase):
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
