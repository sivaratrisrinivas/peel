#!/usr/bin/env python3
"""Derive the public cache-only pivot fixture used by issue #9 tests."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import zipfile


def derive(source: Path, target: Path) -> None:
    with zipfile.ZipFile(source) as package:
        entries = [(info, package.read(info.filename)) for info in package.infolist()]
    entries = [(info, payload) for info, payload in entries if info.filename != "xl/worksheets/sheet1.xml"]
    rewritten: dict[str, bytes] = {}
    for info, payload in entries:
        if info.filename == "xl/workbook.xml":
            payload = re.sub(r'<sheet\b[^>]*\bname="Data"[^>]*/>', "", payload.decode("utf-8")).encode("utf-8")
        elif info.filename == "xl/_rels/workbook.xml.rels":
            payload = re.sub(r'<Relationship\b[^>]*\bTarget="/xl/worksheets/sheet1.xml"[^>]*/>', "", payload.decode("utf-8")).encode("utf-8")
        elif info.filename == "[Content_Types].xml":
            payload = re.sub(r'<Override\b[^>]*\bPartName="/xl/worksheets/sheet1.xml"[^>]*/>', "", payload.decode("utf-8")).encode("utf-8")
        rewritten[info.filename] = payload
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for info, _ in entries:
            package.writestr(info, rewritten[info.filename])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    arguments = parser.parse_args()
    derive(arguments.source, arguments.target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
