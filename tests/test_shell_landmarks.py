"""What Lighthouse and a screen reader need from the app shell in index.html.

The views render into #app, so the landmark, the skip link and the page
description live in the shell and are checked here rather than per view.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHELL = (ROOT / "index.html").read_text(encoding="utf-8")


class ShellLandmarks(unittest.TestCase):
  def test_views_render_into_the_one_main(self):
    self.assertEqual(len(re.findall(r"<main\b", SHELL)), 1)
    self.assertRegex(SHELL, r'<main id="app"')

  def test_the_page_has_a_description(self):
    m = re.search(r'<meta name="description" content="([^"]*)"', SHELL)
    self.assertTrue(m and m.group(1).strip(), "no meta description")

  def test_the_first_link_skips_to_an_element_that_exists(self):
    body = SHELL[SHELL.index("<body"):]
    href = re.search(r'<a\b[^>]*\bhref="([^"]*)"', body).group(1)
    self.assertTrue(href.startswith("#") and len(href) > 1, f"first link is {href}")
    self.assertIn(f'id="{href[1:]}"', body)

  def test_the_nav_brand_is_the_shell_h1(self):
    # The other h1 is the hidden notice for a browser too old to run the app.
    self.assertEqual(len(re.findall(r"<h1\b", SHELL)), 2)
    self.assertRegex(SHELL, r'<h1 class="nav-brand">')
    self.assertRegex(SHELL, r'<div id="webview-notice"[^>]*hidden>\s*<h1>')


if __name__ == "__main__":
  unittest.main()
