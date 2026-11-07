"""Probe for a filesystem that folds NFC and NFD names into one file.

APFS (macOS) does; ext4 (Linux, CI) does not. Tests that write both spellings
of a name to disk can only run where the two stay apart.
"""

from __future__ import annotations

import tempfile
import unicodedata
from functools import cache
from pathlib import Path

FOLDS_REASON = "this filesystem folds NFC and NFD names into one file; run on Linux"


@cache
def folds_unicode_names(where: str | None = None) -> bool:
  """True if a file written under the composed spelling is found under the
  decomposed one, checked once in a temp dir (or under `where`)."""
  composed = unicodedata.normalize("NFC", "å")
  decomposed = unicodedata.normalize("NFD", composed)
  with tempfile.TemporaryDirectory(dir=where) as d:
    (Path(d) / composed).write_bytes(b"")
    return (Path(d) / decomposed).exists()
