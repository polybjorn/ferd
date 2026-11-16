"""The e2e job's Playwright image and package.json's @playwright/test name the
same release. The image carries browsers for one release only, so a commit that
moves one pin without the other fails every browser test; this catches it in
the fast job instead."""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CI = (ROOT / ".forgejo" / "workflows" / "ci.yml").read_text(encoding="utf-8")
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))


class PlaywrightPin(unittest.TestCase):
  def test_image_matches_package(self):
    images = re.findall(r"mcr\.microsoft\.com/playwright:v([0-9.]+)-", CI)
    self.assertTrue(images, "no Playwright image in ci.yml")
    self.assertEqual(set(images), {PACKAGE["devDependencies"]["@playwright/test"]})

  def test_image_is_pinned_by_digest(self):
    # The runner never re-pulls an image named by digest, and a moved tag
    # would otherwise change the browsers under an unchanged commit.
    self.assertRegex(CI, r"mcr\.microsoft\.com/playwright:v[0-9.]+-noble@sha256:[0-9a-f]{64}")


if __name__ == "__main__":
  unittest.main()
