#!/usr/bin/env python3
"""Run the privacy qualification command for a Peel submission."""

import sys
from pathlib import Path

repo_root = Path(__file__).resolve().parents[1]
if str(repo_root) not in sys.path:
    sys.path.insert(0, str(repo_root))

from scripts.submission_qualification import main


if __name__ == "__main__":
    raise SystemExit(main())
