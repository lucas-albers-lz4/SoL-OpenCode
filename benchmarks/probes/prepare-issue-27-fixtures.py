#!/usr/bin/env python3
"""Create isolated fixtures for the issue #27 Action-Fusion and recall probes."""

import argparse
from pathlib import Path

SUM_SH = """#!/bin/sh
set -eu
i=1
sum=0
while [ "$i" -lt "$#" ]; do
  eval "value=\\${$i}"
  sum=$((sum + value))
  i=$((i + 1))
done
printf '%s\\n' "$sum"
"""

TEST_SH = """#!/bin/sh
set -eu
check_sum() {
  expected=$1
  shift
  actual=$(sh ./sum.sh "$@")
  if [ "$actual" != "$expected" ]; then
    printf 'expected %s, got %s\\n' "$expected" "$actual" >&2
    exit 1
  fi
}
check_sum 7 3 4
check_sum 12 3 4 5
check_sum 10 10
printf 'PASS\\n'
"""

SENTINEL = "purple-otter-9f3c"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path, help="new or existing output directory")
    args = parser.parse_args()
    root = args.out.expanduser().resolve() / "fixtures"

    for arm in ("off", "neu"):
        for rep in (1, 2):
            target = root / f"fusion-{arm}-{rep}"
            target.mkdir(parents=True, exist_ok=True)
            (target / "sum.sh").write_text(SUM_SH, encoding="utf-8")
            (target / "test_sum.sh").write_text(TEST_SH, encoding="utf-8")
            (target / "sum.sh").chmod(0o755)
            (target / "test_sum.sh").chmod(0o755)

    for rep in (1, 2):
        target = root / f"recall-neu-{rep}"
        target.mkdir(parents=True, exist_ok=True)
        lines = [
            f"TARGET_SENTINEL={SENTINEL}\n" if i == 50 else f"row-{i:03d}:" + "x" * 160 + "\n"
            for i in range(100)
        ]
        content = "".join(lines)
        (target / "BIG.txt").write_text(content, encoding="utf-8")
        (target / "SENTINEL_OUT.txt").unlink(missing_ok=True)
        assert len(content.encode("utf-8")) > 10 * 1024
        assert content.index("TARGET_SENTINEL=") > 512
        assert content.index("TARGET_SENTINEL=") < len(content) - 512

    print(f"created issue #27 fixtures under {root}")


if __name__ == "__main__":
    main()
