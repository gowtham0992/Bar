#!/usr/bin/env python3
"""Command-line entry point for the fixed Link PR #60 sanitizer."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

from bar_tools.sanitize_pr60 import SanitizationError, sanitize_pr60


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create review-only sanitized candidates for Link PR #60."
    )
    parser.add_argument("--raw", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        destination = sanitize_pr60(arguments.raw, arguments.output, REPOSITORY_ROOT)
    except SanitizationError as error:
        print(f"sanitization failed safely: {error}", file=sys.stderr)
        return 1
    print(f"sanitized review candidate completed outside the repository: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
