"""scripts/typecheck.py, which holds CI's tsc run to types/tsc-baseline.txt."""

import importlib.util
import tempfile
import unittest
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("typecheck", REPO / "scripts" / "typecheck.py")
typecheck = importlib.util.module_from_spec(spec)
spec.loader.exec_module(typecheck)

LINE = "app/a.js(3,7): error TS2339: Property 'value' does not exist on type 'HTMLElement'."
KEY = ("app/a.js", "TS2339", "Property 'value' does not exist on type 'HTMLElement'.")


class ParseTest(unittest.TestCase):
    def test_counts_by_file_code_and_message_without_the_line(self):
        moved = LINE.replace("(3,7)", "(90,1)")
        self.assertEqual(typecheck.parse(LINE + "\n" + moved + "\n"), Counter({KEY: 2}))

    def test_skips_continuation_lines(self):
        self.assertEqual(typecheck.parse(LINE + "\n  Did you mean 'x'?\n"), Counter({KEY: 1}))

    def test_object_types_in_a_message_do_not_key_the_error(self):
        before = "app/a.js(1,1): error TS2339: Property 'x' does not exist on type '{ a: string; }'."
        after = "app/a.js(9,1): error TS2339: Property 'x' does not exist on type '{ a: string; b: number; }'."
        listed = "app/a.js(2,1): error TS7006: Type '{ a: { b: string; }; }[]' is not '{ 'c-d': string; }'."
        self.assertEqual(typecheck.parse(before + "\n" + after + "\n" + listed + "\n"), Counter({
            ("app/a.js", "TS2339", "Property 'x' does not exist on type '{...}'."): 2,
            ("app/a.js", "TS7006", "Type '{...}[]' is not '{...}'."): 1,
        }))

    def test_refuses_output_that_is_not_tsc(self):
        with self.assertRaises(ValueError):
            typecheck.parse("npm ERR! network request failed\n")

    def test_baseline_round_trips(self):
        counts = Counter({KEY: 3, ("-", "TS5023", "Unknown option."): 1})
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "baseline.txt"
            path.write_text(typecheck.format_baseline(counts))
            self.assertEqual(typecheck.read_baseline(path), counts)

    def test_committed_baseline_parses(self):
        # Empty once the last error went; it must still read without raising.
        self.assertIsInstance(typecheck.read_baseline(typecheck.BASELINE), Counter)

    def test_committed_strict_baseline_parses(self):
        self.assertIsInstance(typecheck.read_baseline(typecheck.STRICT_BASELINE), Counter)


class MainTest(unittest.TestCase):
    def test_baseline_option_reads_and_writes_the_named_file(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "tsc.out"
            out.write_text(LINE + "\n")
            base = Path(d) / "strict.txt"
            self.assertEqual(typecheck.main([str(out), "--baseline", str(base), "--update"]), 0)
            self.assertEqual(typecheck.read_baseline(base), Counter({KEY: 1}))
            self.assertEqual(typecheck.main([str(out), "--baseline", str(base)]), 0)
            out.write_text(LINE + "\n" + LINE + "\n")
            self.assertEqual(typecheck.main([str(out), "--baseline", str(base)]), 1)

    def test_baseline_option_without_a_path_is_a_usage_error(self):
        self.assertEqual(typecheck.main(["tsc.out", "--baseline"]), 2)


if __name__ == "__main__":
    unittest.main()
