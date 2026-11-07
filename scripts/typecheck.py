#!/usr/bin/env python3
"""Hold the frontend type-check to its baseline.

Reads `tsc --noEmit --pretty false` output and compares the errors against
types/tsc-baseline.txt, keyed by file, code and message with the line number
left out, so an unrelated edit that moves a line does not fail CI. Any
difference fails: a new error is a regression, and one that went away means
the baseline has to come down with it, in the same commit.

    python3 scripts/typecheck.py tsc.out            # check
    python3 scripts/typecheck.py tsc.out --update   # rewrite the baseline

--baseline PATH holds a second run to its own file: CI checks
tsconfig.strict.json against types/tsc-strict-baseline.txt, so the strict
flags come on one at a time without failing the default check.
"""
import re
import sys
from collections import Counter
from pathlib import Path

TYPES = Path(__file__).resolve().parent.parent / 'types'
BASELINE = TYPES / 'tsc-baseline.txt'
STRICT_BASELINE = TYPES / 'tsc-strict-baseline.txt'
FILE_ERROR = re.compile(r'^(?P<file>.+?)\(\d+,\d+\): error (?P<code>TS\d+): (?P<msg>.*)$')
GLOBAL_ERROR = re.compile(r'^error (?P<code>TS\d+): (?P<msg>.*)$')


def shorten_object_types(msg):
    """Replace each quoted object type with '{...}'.

    A message quoting an object type spells the whole type out, so adding one
    property to the shared state, or one key to the i18n table, would rewrite
    every line that names it. The braces are matched rather than the quotes,
    since keys such as 'rose-pine' are quoted inside the type."""
    out, i = [], 0
    while True:
        start = msg.find("'{", i)
        if start < 0:
            return ''.join(out) + msg[i:]
        depth, j = 0, start + 1
        while j < len(msg):
            depth += {'{': 1, '}': -1}.get(msg[j], 0)
            j += 1
            if depth == 0:
                break
        suffix = j
        while msg.startswith('[]', suffix):
            suffix += 2
        if depth or not msg.startswith("'", suffix):
            out.append(msg[i:start + 2])
            i = start + 2
            continue
        out.append(msg[i:start] + "'{...}" + msg[j:suffix + 1])
        i = suffix + 1


def parse(text):
    """Count errors by (file, code, message). Raise on a line tsc would not print."""
    counts = Counter()
    for line in text.splitlines():
        if not line.strip() or line[0].isspace():
            continue  # blank, or the continuation of a multi-line message
        m = FILE_ERROR.match(line) or GLOBAL_ERROR.match(line)
        if not m:
            # npm failing to fetch tsc, or tsc crashing, must not read as zero errors.
            raise ValueError('not a tsc error line: ' + line)
        msg = shorten_object_types(m['msg'])
        counts[(m.groupdict().get('file') or '-', m['code'], msg)] += 1
    return counts


def format_baseline(counts):
    return ''.join(f'{n}\t{f}\t{c}\t{msg}\n' for (f, c, msg), n in sorted(counts.items()))


def read_baseline(path):
    counts = Counter()
    if path.exists():
        for line in path.read_text().splitlines():
            n, f, c, msg = line.split('\t', 3)
            counts[(f, c, msg)] = int(n)
    return counts


def main(argv):
    args = [a for a in argv if a != '--update']
    baseline_path = BASELINE
    if '--baseline' in args:
        i = args.index('--baseline')
        if i + 1 >= len(args):
            print(__doc__.strip(), file=sys.stderr)
            return 2
        baseline_path = Path(args[i + 1])
        del args[i:i + 2]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        current = parse(Path(args[0]).read_text())
    except ValueError as e:
        print(e, file=sys.stderr)
        return 1
    if not current and read_baseline(baseline_path):
        print('No errors read: check that tsc ran (see the log above), or delete the '
              'baseline once the last error is fixed.', file=sys.stderr)
        return 1
    if '--update' in argv:
        baseline_path.write_text(format_baseline(current))
        print(f'{sum(current.values())} errors written to {baseline_path.name}')
        return 0
    baseline = read_baseline(baseline_path)
    added = current - baseline
    gone = baseline - current
    for (f, c, msg), n in sorted(added.items()):
        print(f'new: {n} x {f} {c}: {msg}')
    for (f, c, msg), n in sorted(gone.items()):
        print(f'fixed: {n} x {f} {c}: {msg}')
    if added or gone:
        if gone and not added:
            print('Errors went away: run with --update and commit the lower baseline.')
        return 1
    print(f'{sum(current.values())} errors, matching the baseline')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
