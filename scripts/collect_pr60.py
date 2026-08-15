#!/usr/bin/env python3
"""Command-line entry point for the fixed Link PR #60 collector."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

from bar_tools.collect_pr60 import CollectorError, capture_pr60


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Capture the frozen Link PR #60 GitHub evidence set."
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="New raw-evidence directory outside the Bar repository.",
    )
    arguments = parser.parse_args()
    try:
        destination = capture_pr60(arguments.output, REPOSITORY_ROOT)
    except CollectorError as error:
        print(f"capture failed safely: {error}", file=sys.stderr)
        return 1
    print(f"raw capture completed outside the repository: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
