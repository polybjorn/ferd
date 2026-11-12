"""robots.txt, the sitemap and the link-preview tags, as text."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from ferd_api import crawl  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


class TestOrigin(unittest.TestCase):
  def test_accepts_hosts_ports_and_addresses(self):
    self.assertEqual(crawl.origin("https", "Maps.Example.org"), "https://maps.example.org")
    self.assertEqual(crawl.origin("http", "127.0.0.1:8091"), "http://127.0.0.1:8091")
    self.assertEqual(crawl.origin("http", "[::1]:8091"), "http://[::1]:8091")

  def test_refuses_what_could_break_out_of_a_page(self):
    for host in (None, "", 'a"b', "a b", "a/b", "a<b>", "a:port", "-a.example"):
      with self.subTest(host=host):
        self.assertIsNone(crawl.origin("https", host))
    self.assertIsNone(crawl.origin("ftp", "example.org"))


class TestCanonical(unittest.TestCase):
  def test_paths(self):
    cases = {
      "/": "/", "/index.html": "/", "/u/": "/",
      "/u/demo": "/u/demo/", "/u/demo/": "/u/demo/", "/u/demo/x/y": "/u/demo/",
      "/u/Bj%C3%B8rn": "/u/Bj%C3%B8rn/", "/u/a%22b": "/u/a%22b/",
    }
    for path, want in cases.items():
      with self.subTest(path=path):
        self.assertEqual(crawl.canonical_path(path), want)

  def test_tags_need_an_origin(self):
    self.assertEqual(crawl.share_tags(None, "/u/demo"), "")
    tags = crawl.share_tags("https://ferd.example", "/u/demo")
    self.assertIn('<link rel="canonical" href="https://ferd.example/u/demo/">', tags)
    self.assertIn('<meta property="og:image" content="https://ferd.example/icons/icon-512.png">', tags)

  def test_the_shell_carries_the_placeholder_and_the_image_exists(self):
    self.assertIn(crawl.SHARE_TAGS_PLACEHOLDER, (ROOT / "index.html").read_text(encoding="utf-8"))
    self.assertTrue((ROOT / crawl.OG_IMAGE_PATH.lstrip("/")).is_file())


class TestRobotsAndSitemap(unittest.TestCase):
  def test_off_shuts_everything_out(self):
    self.assertEqual(crawl.robots_txt("https://ferd.example", False), "User-agent: *\nDisallow: /\n")

  def test_on_allows_and_names_the_sitemap(self):
    body = crawl.robots_txt("https://ferd.example", True)
    self.assertEqual(body.splitlines()[:3], ["User-agent: *", "Allow: /", "Allow: /u/"])
    self.assertIn("Sitemap: https://ferd.example/sitemap.xml", body.splitlines())
    self.assertNotIn("Sitemap", crawl.robots_txt(None, True))

  def test_sitemap_quotes_and_escapes_names(self):
    body = crawl.sitemap_xml("https://ferd.example", ["demo", "a&b"])
    self.assertIn("<loc>https://ferd.example/u/demo/</loc>", body)
    self.assertIn("<loc>https://ferd.example/u/a%26b/</loc>", body)
    self.assertNotIn("<url>", crawl.sitemap_xml(None, ["demo"]))


if __name__ == "__main__":
  unittest.main()
