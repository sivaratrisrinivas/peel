#!/usr/bin/env python3
"""Run the supported clean-workbook engine contract inside Daytona."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path
from typing import Any


API_VERSION = "1"
ENGINE_VERSION = "1.0.0"
OUTPUT_PATH = "/tmp/peel-verified.xlsx"

PROFILE_FILES = {
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/app.xml",
    "docProps/core.xml",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/styles.xml",
    "xl/sharedStrings.xml",
}


def _allowed_profile_part(name: str) -> bool:
    return (
        name in PROFILE_FILES
        or (name.startswith("xl/worksheets/") and name.endswith(".xml"))
        or (name.startswith("xl/theme/") and name.endswith(".xml"))
        or (name.startswith("_rels/") and name.endswith(".rels"))
        or (name.startswith("xl/worksheets/_rels/") and name.endswith(".rels"))
    )


def _refusal(
    operation: str,
    artifact_sha256: str,
    refusal_code: str,
    *,
    original_artifact_sha256: str | None = None,
    artifact_unchanged: bool | None = None,
) -> dict[str, Any]:
    if operation == "scan":
        return {
            "version": API_VERSION,
            "operation": "scan",
            "status": "refused",
            "artifact_sha256": artifact_sha256,
            "engine_version": ENGINE_VERSION,
            "supported_profile": "refused",
            "findings": [],
            "refusal_code": refusal_code,
        }
    unchanged = artifact_unchanged if artifact_unchanged is not None else False
    return {
        "version": API_VERSION,
        "operation": "verify",
        "status": "refused",
        "artifact_sha256": artifact_sha256,
        "original_artifact_sha256": original_artifact_sha256 or artifact_sha256,
        "engine_version": ENGINE_VERSION,
        "artifact_unchanged": unchanged,
        "baseline_sha256": artifact_sha256,
        "remaining_findings": [],
        "refusal_code": refusal_code,
    }


def _scan_package(path: Path, artifact_sha256: str) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(path) as package:
            names = package.namelist()
            if len(names) != len(set(names)):
                return _refusal("scan", artifact_sha256, "unsupported_container")
            required = {"[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"}
            if not required.issubset(names) or not all(_allowed_profile_part(name) for name in names):
                return _refusal("scan", artifact_sha256, "unsupported_content")

            content_types = package.read("[Content_Types].xml").decode("utf-8")
            if "spreadsheetml.sheet.main+xml" not in content_types:
                return _refusal("scan", artifact_sha256, "unsupported_content")
            workbook = package.read("xl/workbook.xml").decode("utf-8")
            findings: list[dict[str, Any]] = []
            hidden_sheets = len(
                re.findall(r"<sheet\b[^>]*\bstate=[\"'](?:hidden|veryHidden)[\"'][^>]*>", workbook, re.IGNORECASE)
            )
            if hidden_sheets:
                findings.append(
                    {"mechanism": "hidden_worksheet", "location": "xl/workbook.xml", "count": hidden_sheets}
                )

            hidden_rows_or_columns = 0
            for name in names:
                if not name.startswith("xl/worksheets/") or not name.endswith(".xml"):
                    continue
                worksheet = package.read(name).decode("utf-8")
                hidden_rows_or_columns += worksheet.count('hidden="1"')
                hidden_rows_or_columns += worksheet.count("hidden='1'")
                hidden_rows_or_columns += worksheet.count('hidden="true"')
                hidden_rows_or_columns += worksheet.count("hidden='true'")
            if hidden_rows_or_columns:
                findings.append(
                    {
                        "mechanism": "hidden_row_or_column",
                        "location": "xl/worksheets",
                        "count": hidden_rows_or_columns,
                    }
                )
    except (OSError, UnicodeDecodeError, zipfile.BadZipFile, KeyError):
        return _refusal("scan", artifact_sha256, "unsupported_container")

    return {
        "version": API_VERSION,
        "operation": "scan",
        "status": "findings" if findings else "clean",
        "artifact_sha256": artifact_sha256,
        "engine_version": ENGINE_VERSION,
        "supported_profile": "accepted",
        "findings": findings,
    }


def _verify_package(path: Path, artifact_sha256: str, original_artifact_sha256: str) -> dict[str, Any]:
    scan = _scan_package(path, artifact_sha256)
    unchanged = artifact_sha256 == original_artifact_sha256
    if scan["status"] != "clean" or not unchanged:
        refusal_code = "integrity_failure" if not unchanged else scan.get("refusal_code", "unsupported_content")
        return _refusal(
            "verify",
            artifact_sha256,
            refusal_code,
            original_artifact_sha256=original_artifact_sha256,
            artifact_unchanged=unchanged,
        )
    shutil.copyfile(path, OUTPUT_PATH)
    return {
        "version": API_VERSION,
        "operation": "verify",
        "status": "verified",
        "artifact_sha256": artifact_sha256,
        "original_artifact_sha256": original_artifact_sha256,
        "engine_version": ENGINE_VERSION,
        "artifact_unchanged": True,
        "baseline_sha256": artifact_sha256,
        "remaining_findings": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operation", choices=("scan", "verify"), required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--original-artifact-sha256")
    args = parser.parse_args()
    actual_sha256 = hashlib.sha256(args.input.read_bytes()).hexdigest()
    if actual_sha256 != args.artifact_sha256:
        result = _refusal(
            args.operation,
            args.artifact_sha256,
            "integrity_failure",
            original_artifact_sha256=args.original_artifact_sha256,
        )
    elif args.operation == "scan":
        result = _scan_package(args.input, args.artifact_sha256)
    elif args.original_artifact_sha256:
        result = _verify_package(args.input, args.artifact_sha256, args.original_artifact_sha256)
    else:
        result = _refusal(args.operation, args.artifact_sha256, "integrity_failure")
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
