"""scripts/prune-releases.py, which deletes superseded betas and old images."""

import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("prune", REPO / "scripts" / "prune-releases.py")
prune = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prune)

NOW = datetime(2026, 11, 14, 12, tzinfo=timezone.utc)


def version(vid, tags, hours_ago=48):
    return {"id": vid, "digest": f"sha256:{vid}", "tags": tags,
            "created": NOW - timedelta(hours=hours_ago)}


class SupersededBetasTest(unittest.TestCase):
    def test_a_stable_release_supersedes_its_betas_except_the_newest(self):
        tags = ["v1.5.0", "v2.0.0-beta.1", "v2.0.0-beta.2", "v2.0.0"]
        self.assertEqual(prune.superseded_betas(tags), {"v2.0.0-beta.1"})

    def test_a_beta_line_absorbed_by_a_later_stable_goes_too(self):
        tags = ["v1.6.0-beta.1", "v2.0.0-beta.1", "v2.0.0"]
        self.assertEqual(prune.superseded_betas(tags), {"v1.6.0-beta.1"})

    def test_a_beta_for_the_next_version_stays(self):
        tags = ["v2.0.0", "v2.0.0-beta.4", "v2.1.0-beta.1", "v2.1.0-beta.2"]
        self.assertEqual(prune.superseded_betas(tags), {"v2.0.0-beta.4"})

    def test_betas_compare_numerically(self):
        tags = ["v1.10.0", "v1.10.0-beta.9", "v1.10.0-beta.10"]
        self.assertEqual(prune.superseded_betas(tags), {"v1.10.0-beta.9"})

    def test_nothing_goes_without_a_stable_release(self):
        self.assertEqual(prune.superseded_betas(["v2.0.0-beta.1", "v2.0.0-beta.2"]), set())


class PlanImagesTest(unittest.TestCase):
    def plan(self, versions, children=None, keep=2):
        return {v["id"] for v in prune.plan_images(versions, children or {}, keep, NOW)}

    def test_superseded_beta_images_and_their_children_go(self):
        versions = [version("stable", ["2.0.0", "2.0", "2", "latest"]),
                    version("b1", ["2.0.0-beta.1"]), version("b1amd", []),
                    version("b2", ["2.0.0-beta.2", "beta"]), version("b2amd", [])]
        children = {"sha256:stable": [], "sha256:b2": ["sha256:b2amd"]}
        self.assertEqual(self.plan(versions, children), {"b1", "b1amd"})

    def test_only_the_newest_commit_builds_stay(self):
        versions = [version(f"c{i}", [f"abc{i:04x}"], hours_ago=10 + i) for i in range(4)]
        versions.append(version("dev", ["dev", "abcffff"], hours_ago=50))
        self.assertEqual(self.plan(versions), {"c2", "c3"})

    def test_an_all_digit_commit_tag_is_a_commit_build(self):
        versions = [version("new", ["abcdef0"], hours_ago=1), version("old", ["9515132"])]
        self.assertEqual(self.plan(versions, keep=1), {"old"})

    def test_a_child_a_kept_tag_references_stays(self):
        versions = [version("stable", ["1.5.0", "1.5", "1"]), version("shared", [])]
        self.assertEqual(self.plan(versions, {"sha256:stable": ["sha256:shared"]}), set())

    def test_an_untagged_manifest_from_a_push_in_progress_stays(self):
        versions = [version("fresh", [], hours_ago=0.5), version("orphan", [], hours_ago=3)]
        self.assertEqual(self.plan(versions), {"orphan"})

    def test_an_unknown_tag_keeps_its_version(self):
        self.assertEqual(self.plan([version("pr", ["pr-12"])]), set())

    def test_a_moved_tag_keeps_a_superseded_beta(self):
        versions = [version("x", ["2.0.0-beta.1", "beta"]), version("y", ["2.0.0-beta.2"]),
                    version("s", ["2.0.0"])]
        self.assertEqual(self.plan(versions), set())

    def test_a_protected_tag_on_a_doomed_version_stops_the_run(self):
        versions = [version("s", ["2.0.0", "latest"])]
        original = prune.droppable
        prune.droppable = lambda *_: {"s"}
        try:
            with self.assertRaises(SystemExit):
                self.plan(versions)
        finally:
            prune.droppable = original


if __name__ == "__main__":
    unittest.main()
