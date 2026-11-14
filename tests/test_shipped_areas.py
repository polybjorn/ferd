"""Validate the shipped area catalog (`<repo_root>/catalog-areas.json`) with
the same checks as the route catalog: relation IDs and hand-written metadata,
no geometry."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import test_shipped_routes  # noqa: E402
from ferd_api.osm import AREA_CATALOG_FIELDS, validate_area_entry  # noqa: E402


class ShippedAreasTests(test_shipped_routes.ShippedRoutesTests):
  PATH = test_shipped_routes.REPO_ROOT / "catalog-areas.json"
  FIELDS = AREA_CATALOG_FIELDS
  validate = staticmethod(validate_area_entry)


if __name__ == "__main__":
  unittest.main()
