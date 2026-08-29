#!/usr/bin/env python3
"""Run the supported clean-workbook engine contract inside Daytona."""

from __future__ import annotations

import argparse
import base64
import io
import hashlib
import importlib
import json
import re
import shutil
import struct
import sys
import zipfile
from xml.etree import ElementTree
from pathlib import Path
from typing import Any


API_VERSION = "1"
ENGINE_VERSION = "1.0.0"
MAX_WORKSHEET_ROWS = 1_048_576
MAX_WORKSHEET_COLUMNS = 16_384
OUTPUT_PATH = "/tmp/peel-verified.xlsx"
REPAIR_OUTPUT_PATH = "/tmp/peel-repaired.xlsx"

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
        or (name.startswith("xl/worksheets/") and name.endswith(".rels"))
        or (name.startswith("xl/theme/") and name.endswith(".xml"))
        or (name.startswith("_rels/") and name.endswith(".rels"))
        or (name.startswith("xl/worksheets/_rels/") and name.endswith(".rels"))
        or (name.startswith("xl/tables/") and name.endswith(".xml"))
        or (name.startswith("xl/drawings/") and name.endswith((".xml", ".rels")))
        or (name.startswith("xl/charts/") and name.endswith(".xml"))
        or (name.startswith("xl/pivotTables/") and name.endswith(".xml"))
        or (name.startswith("xl/pivotCache/") and name.endswith(".xml"))
        or (name.startswith("xl/externalLinks/") and name.endswith((".xml", ".rels")))
        or name in {"xl/connections.xml", "xl/vbaProject.bin"}
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


def _xml_attribute(attributes: str, name: str) -> str | None:
    match = re.search(rf"(?:^|\s){re.escape(name)}=[\"']([^\"']*)[\"']", attributes, re.IGNORECASE)
    return match.group(1) if match else None


def _local_element(element: str) -> str:
    return rf"(?:[A-Za-z_][\w.-]*:)?(?:{element})"


def _decode_xml(value: str) -> str:
    return (
        value.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
        .replace("&amp;", "&")
    )


def _normalize_path(path: str) -> str:
    parts: list[str] = []
    for part in path.lstrip("/").split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return "/".join(parts)


def _relationship_source(path: str) -> str:
    if path == "_rels/.rels":
        return ""
    marker = "/_rels/"
    marker_index = path.find(marker)
    if marker_index < 0:
        return ""
    return f"{path[:marker_index]}/{path[marker_index + len(marker):].removesuffix('.rels')}"


def _relationship_target(path: str, target: str) -> str:
    source = _relationship_source(path)
    directory = source.rsplit("/", 1)[0] if "/" in source else ""
    return _normalize_path(target if target.startswith("/") else f"{directory}/{target}")


def _relationship_entries(files: dict[str, bytes]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for member, payload in files.items():
        if not member.endswith(".rels"):
            continue
        xml = payload.decode("utf-8")
        for match in re.finditer(rf"<{_local_element('Relationship')}\b([^>]*)/?>(?:</{_local_element('Relationship')}>)?", xml, re.IGNORECASE):
            attributes = match.group(1)
            target = _xml_attribute(attributes, "Target")
            if not target or (_xml_attribute(attributes, "TargetMode") or "").lower() == "external":
                continue
            result.append(
                {
                    "source": _relationship_source(member),
                    "target": _relationship_target(member, target),
                    "type": _xml_attribute(attributes, "Type") or "",
                    "member": member,
                }
            )
    return result


def _workbook_sheets(files: dict[str, bytes]) -> list[dict[str, str]]:
    workbook = files["xl/workbook.xml"].decode("utf-8")
    relationships: dict[str, str] = {}
    rels = files.get("xl/_rels/workbook.xml.rels", b"").decode("utf-8")
    for match in re.finditer(rf"<{_local_element('Relationship')}\b([^>]*)/?>(?:</{_local_element('Relationship')}>)?", rels, re.IGNORECASE):
        attributes = match.group(1)
        relationship_id = _xml_attribute(attributes, "Id")
        target = _xml_attribute(attributes, "Target")
        if relationship_id and target and (_xml_attribute(attributes, "TargetMode") or "").lower() != "external":
            relationships[relationship_id] = _relationship_target("xl/_rels/workbook.xml.rels", target)
    sheets: list[dict[str, str]] = []
    for match in re.finditer(rf"<{_local_element('sheet')}\b([^>]*)/?>(?:</{_local_element('sheet')}>)?", workbook, re.IGNORECASE):
        attributes = match.group(1)
        relationship_id = _xml_attribute(attributes, "r:id") or _xml_attribute(attributes, "id") or ""
        sheets.append(
            {
                "name": _decode_xml(_xml_attribute(attributes, "name") or ""),
                "state": (_xml_attribute(attributes, "state") or "visible").lower(),
                "relationship_id": relationship_id,
                "path": relationships.get(relationship_id, ""),
            }
        )
    return sheets


def _contains_sheet_reference(xml: str, sheet: dict[str, str]) -> bool:
    xml = _decode_xml(xml)
    name = sheet["name"].replace("'", "''")
    if not name:
        return False
    escaped = re.escape(name)
    return (
        bool(re.search(rf"(?:'{escaped}'|{escaped})!", xml, re.IGNORECASE))
        or bool(re.search(rf"(?:^|\s)sheet=[\"']?'{escaped}'?[\"']", xml, re.IGNORECASE))
        or (bool(sheet["path"]) and sheet["path"] in xml)
    )


def _matching_element(xml: str, element: str, sheet: dict[str, str]) -> bool:
    return any(_contains_sheet_reference(match.group(0), sheet) for match in re.finditer(rf"<{_local_element(element)}\b[^>]*>[\s\S]*?</{_local_element(element)}>", xml, re.IGNORECASE))


def _cell_info(reference: str) -> tuple[str, int, int] | None:
    match = re.fullmatch(r"\$?([A-Z]{1,3})\$?([1-9][0-9]*)", reference, re.IGNORECASE)
    if not match:
        return None
    column = _column_number(match.group(1))
    try:
        row = int(match.group(2))
    except ValueError:
        return None
    if column > MAX_WORKSHEET_COLUMNS or row > MAX_WORKSHEET_ROWS:
        return None
    return f"{match.group(1).upper()}{row}", column, row


def _column_number(column: str) -> int:
    result = 0
    for character in column.upper():
        result = result * 26 + ord(character) - 64
    return result


def _hidden_dimension_ranges(xml: str) -> tuple[set[int], list[tuple[int, int]]]:
    rows: set[int] = set()
    for match in re.finditer(rf"<{_local_element('row')}\b([^>]*)/?>(?:</{_local_element('row')}>)?", xml, re.IGNORECASE):
        attributes = match.group(1)
        if not re.search(r"(?:^|\s)hidden=[\"'](?:1|true)[\"']", attributes, re.IGNORECASE):
            continue
        value = _xml_attribute(attributes, "r")
        if value and value.isdigit() and int(value) > 0:
            rows.add(int(value))
    columns: list[tuple[int, int]] = []
    for match in re.finditer(rf"<{_local_element('col')}\b([^>]*)/?>(?:</{_local_element('col')}>)?", xml, re.IGNORECASE):
        attributes = match.group(1)
        if not re.search(r"(?:^|\s)hidden=[\"'](?:1|true)[\"']", attributes, re.IGNORECASE):
            continue
        minimum = _xml_attribute(attributes, "min")
        maximum = _xml_attribute(attributes, "max")
        if minimum and maximum and minimum.isdigit() and maximum.isdigit() and int(minimum) > 0 and int(maximum) >= int(minimum):
            columns.append((int(minimum), int(maximum)))
    return rows, columns


def _concealed_cell_summary(xml: str) -> tuple[list[str], int]:
    _, hidden_columns = _hidden_dimension_ranges(xml)
    cells: list[tuple[int, int, str]] = []
    unresolved = 0
    row_pattern = re.compile(rf"<{_local_element('row')}\b([^>]*)>([\s\S]*?)</{_local_element('row')}>", re.IGNORECASE)
    cell_pattern = re.compile(rf"<{_local_element('c')}\b([^>]*?)(?:/>|>([\s\S]*?)</{_local_element('c')}>)", re.IGNORECASE)
    for row_match in row_pattern.finditer(xml):
        row_hidden = bool(re.search(r"(?:^|\s)hidden=[\"'](?:1|true)[\"']", row_match.group(1), re.IGNORECASE))
        for cell_match in cell_pattern.finditer(row_match.group(2)):
            if not re.search(rf"<{_local_element('f|v|is')}\b", cell_match.group(2) or "", re.IGNORECASE):
                continue
            reference = _cell_info(_xml_attribute(cell_match.group(1), "r") or "")
            hidden_column = reference is not None and any(minimum <= reference[1] <= maximum for minimum, maximum in hidden_columns)
            if not row_hidden and not hidden_column and not (reference is None and hidden_columns):
                continue
            if reference is None:
                unresolved += 1
            else:
                cells.append((reference[2], reference[1], reference[0]))
    return [reference for _, _, reference in sorted(cells)], unresolved


def _concealed_cells(xml: str) -> list[str]:
    return _concealed_cell_summary(xml)[0]


def _unresolved_concealed_values(xml: str) -> int:
    return _concealed_cell_summary(xml)[1]


def _shared_string_cells(xml: str, cells: list[str]) -> list[str]:
    targets = {parsed[0] for value in cells if (parsed := _cell_info(value)) is not None}
    cell_pattern = re.compile(rf"<{_local_element('c')}\b([^>]*?)(?:/>|>([\s\S]*?)</{_local_element('c')}>)", re.IGNORECASE)
    result: list[str] = []
    for match in cell_pattern.finditer(xml):
        if (_xml_attribute(match.group(1), "t") or "").lower() != "s":
            continue
        reference = _cell_info(_xml_attribute(match.group(1), "r") or "")
        if reference is not None and reference[0] in targets:
            result.append(reference[0])
    return result


def _concealed_cells_by_worksheet(files: dict[str, bytes], sheets: list[dict[str, str]]) -> dict[str, list[str]]:
    return {
        sheet["path"]: cells
        for sheet in sheets
        if sheet["path"] in files
        for cells in [_concealed_cells(files[sheet["path"]].decode("utf-8"))]
        if cells
    }


def _unresolved_concealed_values_by_worksheet(files: dict[str, bytes], sheets: list[dict[str, str]]) -> dict[str, int]:
    return {
        sheet["path"]: count
        for sheet in sheets
        if sheet["path"] in files
        for count in [_unresolved_concealed_values(files[sheet["path"]].decode("utf-8"))]
        if count
    }


def _cell_in_range(reference: tuple[str, int, int], start: tuple[str, int, int], end: tuple[str, int, int]) -> bool:
    return (
        min(start[2], end[2]) <= reference[2] <= max(start[2], end[2])
        and min(start[1], end[1]) <= reference[1] <= max(start[1], end[1])
    )


def _column_range_contains_targets(targets: list[tuple[str, int, int]], start: str, end: str) -> bool:
    start_column = _column_number(start)
    end_column = _column_number(end)
    return any(min(start_column, end_column) <= target[1] <= max(start_column, end_column) for target in targets)


def _row_range_contains_targets(targets: list[tuple[str, int, int]], start: str, end: str) -> bool:
    start_row = int(start)
    end_row = int(end)
    return any(min(start_row, end_row) <= target[2] <= max(start_row, end_row) for target in targets)


def _sheet_in_span(
    sheet: dict[str, str], first: str, last: str, sheet_order: list[dict[str, str]] | None
) -> bool:
    def normalized(name: str) -> str:
        return name.replace("''", "'").strip().casefold()

    ordered = sheet_order or []
    target_index = next((index for index, candidate in enumerate(ordered) if normalized(candidate["name"]) == normalized(sheet["name"])), -1)
    first_index = next((index for index, candidate in enumerate(ordered) if normalized(candidate["name"]) == normalized(first)), -1)
    last_index = next((index for index, candidate in enumerate(ordered) if normalized(candidate["name"]) == normalized(last)), -1)
    if target_index >= 0 and first_index >= 0 and last_index >= 0:
        return min(first_index, last_index) <= target_index <= max(first_index, last_index)
    return normalized(first) == normalized(sheet["name"]) or normalized(last) == normalized(sheet["name"])


def _three_dimensional_range_contains_targets(
    text: str,
    sheet: dict[str, str],
    targets: list[tuple[str, int, int]],
    sheet_order: list[dict[str, str]],
    range_kind: str,
) -> bool:
    for first in sheet_order:
        for last in sheet_order:
            if first["path"] == last["path"] or not _sheet_in_span(sheet, first["name"], last["name"], sheet_order):
                continue
            prefixes = (
                rf"'{re.escape(first['name'].replace(chr(39), chr(39) * 2))}:{re.escape(last['name'].replace(chr(39), chr(39) * 2))}'!",
                rf"(?<![A-Za-z0-9_]){re.escape(first['name'])}:{re.escape(last['name'])}!",
            )
            if range_kind == "cells":
                suffix = r"\$?([A-Z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Z]{1,3})\$?([1-9][0-9]*))?"
            elif range_kind == "columns":
                suffix = r"\$?([A-Z]{1,3}):\$?([A-Z]{1,3})"
            else:
                suffix = r"\$?([1-9][0-9]*):\$?([1-9][0-9]*)"
            for prefix in prefixes:
                for match in re.finditer(prefix + suffix, text, re.IGNORECASE):
                    if range_kind == "columns" and _column_range_contains_targets(targets, match.group(1), match.group(2)):
                        return True
                    if range_kind == "rows" and _row_range_contains_targets(targets, match.group(1), match.group(2)):
                        return True
                    if range_kind == "cells":
                        start = _cell_info(f"{match.group(1)}{match.group(2)}")
                        end = _cell_info(f"{match.group(3) or match.group(1)}{match.group(4) or match.group(2)}")
                        if start and end and any(_cell_in_range(target, start, end) for target in targets):
                            return True
    return False


def _references_cells(
    text: str,
    sheet: dict[str, str],
    cells: list[str],
    current_sheet_path: str | None = None,
    allow_unqualified_when_unknown_sheet: bool = False,
    sheet_order: list[dict[str, str]] | None = None,
) -> bool:
    targets = [cell for cell in (_cell_info(value) for value in cells) if cell is not None]
    if not targets:
        return False
    decoded = _decode_xml(text)
    qualified_sheet_prefix = (
        rf"(?:'{re.escape(sheet['name'].replace(chr(39), chr(39) * 2))}'|"
        rf"(?<![A-Za-z0-9_]){re.escape(sheet['name'])})!"
    )
    reference_pattern = re.compile(
        qualified_sheet_prefix
        + r"\$?([A-Z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Z]{1,3})\$?([1-9][0-9]*))?",
        re.IGNORECASE,
    )
    for match in reference_pattern.finditer(decoded):
        start = _cell_info(f"{match.group(1)}{match.group(2)}")
        end = _cell_info(f"{match.group(3) or match.group(1)}{match.group(4) or match.group(2)}")
        if start and end and any(_cell_in_range(target, start, end) for target in targets):
            return True
    if (
        _three_dimensional_range_contains_targets(decoded, sheet, targets, sheet_order, "cells")
        or _three_dimensional_range_contains_targets(decoded, sheet, targets, sheet_order, "columns")
        or _three_dimensional_range_contains_targets(decoded, sheet, targets, sheet_order, "rows")
    ):
        return True
    qualified_column_pattern = re.compile(
        qualified_sheet_prefix + r"\$?([A-Z]{1,3}):\$?([A-Z]{1,3})",
        re.IGNORECASE,
    )
    for match in qualified_column_pattern.finditer(decoded):
        if _column_range_contains_targets(targets, match.group(1), match.group(2)):
            return True
    qualified_row_pattern = re.compile(
        qualified_sheet_prefix + r"\$?([1-9][0-9]*):\$?([1-9][0-9]*)",
        re.IGNORECASE,
    )
    for match in qualified_row_pattern.finditer(decoded):
        if _row_range_contains_targets(targets, match.group(1), match.group(2)):
            return True
    if current_sheet_path != sheet["path"] and not allow_unqualified_when_unknown_sheet:
        return False
    local_pattern = re.compile(
        r"(?:^|[^A-Za-z0-9_])\$?([A-Z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Z]{1,3})\$?([1-9][0-9]*))?(?![A-Za-z0-9_])",
        re.IGNORECASE,
    )
    for match in local_pattern.finditer(decoded):
        start = _cell_info(f"{match.group(1)}{match.group(2)}")
        end = _cell_info(f"{match.group(3) or match.group(1)}{match.group(4) or match.group(2)}")
        if start and end and any(_cell_in_range(target, start, end) for target in targets):
            return True
    local_column_pattern = re.compile(
        r"(?:^|[^A-Za-z0-9_])\$?([A-Z]{1,3}):\$?([A-Z]{1,3})(?![A-Za-z0-9_])",
        re.IGNORECASE,
    )
    for match in local_column_pattern.finditer(decoded):
        if _column_range_contains_targets(targets, match.group(1), match.group(2)):
            return True
    local_row_pattern = re.compile(
        r"(?:^|[^A-Za-z0-9_])\$?([1-9][0-9]*):\$?([1-9][0-9]*)(?![A-Za-z0-9_])",
        re.IGNORECASE,
    )
    for match in local_row_pattern.finditer(decoded):
        if _row_range_contains_targets(targets, match.group(1), match.group(2)):
            return True
    return False


def _matching_elements_for_cells(
    xml: str,
    element: str,
    sheet: dict[str, str],
    cells: list[str],
    current_sheet_path: str | None = None,
    allow_unqualified_when_unknown_sheet: bool = False,
    sheet_order: list[dict[str, str]] | None = None,
) -> bool:
    for match in re.finditer(rf"<{_local_element(element)}\b[^>]*(?:/>|>[\s\S]*?</{_local_element(element)}>)", xml, re.IGNORECASE):
        element_xml = match.group(0)
        if element.casefold() == "definedname":
            attributes = re.search(rf"<{_local_element(element)}\b([^>]*)", element_xml, re.IGNORECASE)
            local_sheet_id = _xml_attribute(attributes.group(1), "localSheetId") if attributes else None
            if local_sheet_id is not None:
                try:
                    index = int(local_sheet_id)
                except ValueError:
                    return True
                if index < 0 or sheet_order is None or index >= len(sheet_order):
                    return True
                if sheet_order[index]["path"] != sheet["path"]:
                    continue
                if _references_cells(element_xml, sheet, cells, sheet["path"], False, sheet_order):
                    return True
            elif _references_cells(element_xml, sheet, cells, None, True, sheet_order):
                # Workbook-scoped relative names have no owning worksheet.
                # Refuse conservatively when their coordinates could name a target.
                return True
            continue
        if _references_cells(element_xml, sheet, cells, current_sheet_path, allow_unqualified_when_unknown_sheet, sheet_order):
            return True
    return False


def _relationship_path_to_worksheet(
    member: str, worksheet: str, relationships: list[dict[str, str]]
) -> list[str] | None:
    if member == worksheet:
        return []
    current = member
    seen: set[str] = set()
    path: list[str] = []
    while current not in seen:
        seen.add(current)
        relation = next((candidate for candidate in relationships if candidate["target"] == current), None)
        if relation is None:
            return None
        path.append(relation["member"])
        if relation["source"] == worksheet:
            return path
        current = relation["source"]
    return None


def _member_is_related_to_worksheet(member: str, worksheet: str, relationships: list[dict[str, str]]) -> bool:
    return _relationship_path_to_worksheet(member, worksheet, relationships) is not None


def _empty_dependency_analysis() -> dict[str, list[str]]:
    return {
        "visible_formulas": [],
        "defined_names": [],
        "data_validation": [],
        "tables": [],
        "charts": [],
        "pivots": [],
        "package_relationships": [],
        "macros": [],
        "external_connections": [],
    }


def _unique(values: list[str]) -> list[str]:
    return sorted(set(values))


def _has_macro(files: dict[str, bytes]) -> bool:
    content_types = files.get("[Content_Types].xml", b"").decode("utf-8")
    return "xl/vbaProject.bin" in files or "macroEnabled" in content_types


def _has_external_connection(files: dict[str, bytes]) -> bool:
    return any(name == "xl/connections.xml" or name.startswith("xl/externalLinks/") for name in files)


def _worksheet_relationship_member(path: str) -> str:
    directory, _, filename = path.rpartition("/")
    return f"{directory + '/' if directory else ''}_rels/{filename}.rels"


def _has_content_type_override(files: dict[str, bytes], target: str) -> bool:
    content_types = files.get("[Content_Types].xml", b"").decode("utf-8")
    for match in re.finditer(rf"<{_local_element('Override')}\b([^>]*?)(?:/>|>[\s\S]*?</{_local_element('Override')}>)", content_types, re.IGNORECASE):
        part_name = _xml_attribute(match.group(1), "PartName")
        if part_name is not None and _normalize_path(part_name) == target:
            return True
    return False


def _repair_action(sheet: dict[str, str], files: dict[str, bytes]) -> dict[str, Any]:
    relationship_part = _worksheet_relationship_member(sheet["path"])
    changed = _unique(
        (["[Content_Types].xml"] if _has_content_type_override(files, sheet["path"]) else [])
        + ["xl/_rels/workbook.xml.rels", "xl/workbook.xml", sheet["path"]]
        + ([relationship_part] if relationship_part in files else [])
    )
    return {
        "kind": "delete_hidden_worksheet",
        "worksheet": sheet["name"],
        "target_member": sheet["path"],
        "changed_members": changed,
        "capability_losses": [
            f"The hidden worksheet {sheet['name']}, its cells, hidden state, row and column metadata, and sheet-local formatting will be removed.",
            "No visible formulas, defined names, data validation, tables, charts, pivots, package relationships, macros, or external connections reference this worksheet; none of those capabilities are changed by this plan.",
            "The structural Repair does not recalculate workbook formulas or cached values after the worksheet is removed.",
        ],
    }


def _clear_action(sheet: dict[str, str], cells: list[str]) -> dict[str, Any]:
    return {
        "kind": "clear_hidden_cell_values",
        "worksheet": sheet["name"],
        "target_member": sheet["path"],
        "cell_references": list(cells),
        "changed_members": [sheet["path"]],
        "capability_losses": [
            f"The concealed values in worksheet {sheet['name']} at {', '.join(cells)} will be cleared.",
            "The hidden row and column dimensions, cell formatting, formulas outside these cells, and unrelated package members are preserved.",
            "The cleared values cannot be restored from the repaired artifact; the original Artifact Reference remains unchanged.",
        ],
    }


def _build_repair_plan(
    files: dict[str, bytes],
    sheets: list[dict[str, str]],
    findings: list[dict[str, Any]],
    artifact_sha256: str,
    unresolved_by_worksheet: dict[str, int],
) -> dict[str, Any] | None:
    hidden = [sheet for sheet in sheets if sheet["state"] in {"hidden", "veryhidden"}]
    concealed_by_worksheet = _concealed_cells_by_worksheet(files, sheets)
    if not hidden and not concealed_by_worksheet and not unresolved_by_worksheet:
        return None
    dependencies = _empty_dependency_analysis()
    relationships = _relationship_entries(files)
    reasons: list[str] = []
    actions: list[dict[str, Any]] = []
    unknown = [name for name in files if not _allowed_profile_part(name)]
    if unknown:
        reasons.append(f"Unsupported content-bearing package members: {', '.join(sorted(unknown))}")
    if _has_macro(files):
        dependencies["macros"].append("[Content_Types].xml/vbaProject.bin")
        reasons.append("Macros are present and cannot be preserved by this Repair.")
    if _has_external_connection(files):
        dependencies["external_connections"].extend(
            name for name in files if name == "xl/connections.xml" or name.startswith("xl/externalLinks/")
        )
        reasons.append("External connections are present and cannot be proven safe by this Repair.")
    if any(finding["mechanism"] not in {"hidden_worksheet", "hidden_row_or_column"} for finding in findings):
        reasons.append("The complete plan contains a concealed mechanism that this Repair does not transform.")
    for sheet in sheets:
        if (
            not sheet["path"]
            or not sheet["path"].startswith("xl/worksheets/")
            or not sheet["path"].endswith(".xml")
            or sheet["path"] not in files
        ):
            reasons.append(f"Worksheet {sheet['name']} has no valid worksheet package member.")

    for sheet in hidden:
        if (
            not sheet["path"]
            or not sheet["path"].startswith("xl/worksheets/")
            or not sheet["path"].endswith(".xml")
            or sheet["path"] not in files
        ):
            reasons.append(f"The hidden worksheet {sheet['name']} has no resolvable package relationship.")
            continue
        sheet_reasons: list[str] = []
        visible_sheet_paths = {
            candidate["path"]
            for candidate in sheets
            if candidate["state"] not in {"hidden", "veryhidden"}
        }
        for member, payload in files.items():
            xml = payload.decode("utf-8", errors="strict") if member.endswith((".xml", ".rels")) else ""
            if member in visible_sheet_paths and _matching_element(xml, "f", sheet):
                dependencies["visible_formulas"].append(member)
                sheet_reasons.append(f"visible formula in {member}")
            if member == "xl/workbook.xml" and _matching_element(xml, "definedName", sheet):
                dependencies["defined_names"].append(member)
                sheet_reasons.append("defined name in xl/workbook.xml")
            if member.startswith("xl/worksheets/") and member.endswith(".xml") and member != sheet["path"] and _matching_element(xml, "dataValidation", sheet):
                dependencies["data_validation"].append(member)
                sheet_reasons.append(f"data validation in {member}")
            if member.startswith("xl/tables/") and member.endswith(".xml") and _contains_sheet_reference(xml, sheet):
                dependencies["tables"].append(member)
                sheet_reasons.append(f"table in {member}")
            if (member.startswith("xl/charts/") or member.startswith("xl/drawings/")) and member.endswith(".xml") and _contains_sheet_reference(xml, sheet):
                dependencies["charts"].append(member)
                sheet_reasons.append(f"chart or drawing in {member}")
            if member.startswith("xl/pivot") and member.endswith(".xml") and _contains_sheet_reference(xml, sheet):
                dependencies["pivots"].append(member)
                sheet_reasons.append(f"pivot in {member}")
        for relation in relationships:
            if relation["target"] == sheet["path"] and relation["source"] != "xl/workbook.xml":
                dependencies["package_relationships"].append(relation["member"])
                sheet_reasons.append(f"package relationship in {relation['member']}")
            if relation["source"] == sheet["path"]:
                dependencies["package_relationships"].append(relation["member"])
                relation_type = relation["type"].lower()
                if "table" in relation_type:
                    dependencies["tables"].append(relation["target"])
                    sheet_reasons.append(f"table relationship in {relation['member']}")
                elif "chart" in relation_type or "drawing" in relation_type:
                    dependencies["charts"].append(relation["target"])
                    sheet_reasons.append(f"chart relationship in {relation['member']}")
                elif "pivot" in relation_type:
                    dependencies["pivots"].append(relation["target"])
                    sheet_reasons.append(f"pivot relationship in {relation['member']}")
                else:
                    sheet_reasons.append(f"package relationship in {relation['member']}")
        if sheet_reasons:
            reasons.append(f"Hidden worksheet {sheet['name']} has dependencies: {', '.join(_unique(sheet_reasons))}.")
        else:
            actions.append(_repair_action(sheet, files))

    visible_sheet_paths = {
        candidate["path"]
        for candidate in sheets
        if candidate["state"] not in {"hidden", "veryhidden"}
    }
    for sheet in sheets:
        if sheet["state"] in {"hidden", "veryhidden"}:
            continue
        cells = concealed_by_worksheet.get(sheet["path"], [])
        unresolved_count = unresolved_by_worksheet.get(sheet["path"], 0)
        if not cells and not unresolved_count:
            continue
        sheet_reasons: list[str] = []
        dependent_members: set[str] = set()
        if unresolved_count:
            sheet_reasons.append(f"{unresolved_count} concealed value(s) without an exact cell reference")
        shared_cell_references = _shared_string_cells(files[sheet["path"]].decode("utf-8"), cells)
        if shared_cell_references:
            sheet_reasons.append("shared-string value in xl/sharedStrings.xml")
        for member, payload in files.items():
            xml = payload.decode("utf-8", errors="strict") if member.endswith((".xml", ".rels")) else ""
            related_to_sheet = member == sheet["path"] or _member_is_related_to_worksheet(member, sheet["path"], relationships)
            if member in visible_sheet_paths and _matching_elements_for_cells(xml, "f", sheet, cells, member, False, sheets):
                dependencies["visible_formulas"].append(member)
                dependent_members.add(member)
                sheet_reasons.append("visible formula in " + member)
            if member == "xl/workbook.xml" and _matching_elements_for_cells(
                xml, "definedName", sheet, cells, sheet_order=sheets
            ):
                dependencies["defined_names"].append(member)
                dependent_members.add(member)
                sheet_reasons.append("defined name in xl/workbook.xml")
            if member in visible_sheet_paths and _matching_elements_for_cells(xml, "dataValidation", sheet, cells, member, False, sheets):
                dependencies["data_validation"].append(member)
                dependent_members.add(member)
                sheet_reasons.append("data validation in " + member)
            if member.startswith("xl/tables/") and member.endswith(".xml") and _references_cells(
                xml, sheet, cells, sheet["path"] if related_to_sheet else None, False, sheets
            ):
                dependencies["tables"].append(member)
                dependent_members.add(member)
                sheet_reasons.append("table in " + member)
            if (
                (member.startswith("xl/charts/") or member.startswith("xl/drawings/"))
                and member.endswith(".xml")
                and _references_cells(xml, sheet, cells, sheet["path"] if related_to_sheet else None, False, sheets)
            ):
                dependencies["charts"].append(member)
                dependent_members.add(member)
                sheet_reasons.append("chart or drawing in " + member)
            if member.startswith("xl/pivot") and member.endswith(".xml") and _references_cells(
                xml, sheet, cells, sheet["path"] if related_to_sheet else None, False, sheets
            ):
                dependencies["pivots"].append(member)
                dependent_members.add(member)
                sheet_reasons.append("pivot in " + member)
        for dependent_member in dependent_members:
            for relation_member in _relationship_path_to_worksheet(dependent_member, sheet["path"], relationships) or []:
                dependencies["package_relationships"].append(relation_member)
                sheet_reasons.append("package relationship in " + relation_member)
        if sheet_reasons:
            reasons.append(
                f"Concealed values in worksheet {sheet['name']} have dependencies: "
                + ", ".join(_unique(sheet_reasons))
                + "."
            )
        else:
            actions.append(_clear_action(sheet, cells))

    plan: dict[str, Any] = {
        "version": API_VERSION,
        "operation": "repair_plan",
        "status": "eligible" if not reasons and actions else "refused",
        "artifact_sha256": artifact_sha256,
        "engine_version": ENGINE_VERSION,
        "dependency_analysis": {key: _unique(value) for key, value in dependencies.items()},
        "actions": actions if not reasons else [],
        "changed_members": _unique([member for action in actions for member in action["changed_members"]]) if not reasons else [],
        "capability_losses": _unique(
            [loss for action in actions for loss in action["capability_losses"]] + reasons
        ),
    }
    if reasons:
        plan["refusal_reasons"] = _unique(reasons)
    return plan


def _inspect_package(path: Path, artifact_sha256: str) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(path) as package:
            names = package.namelist()
            if len(names) != len(set(names)):
                return {"files": {}, "sheets": [], "findings": [], "profile_accepted": False, "unknown": []}
            files = {name: package.read(name) for name in names}
    except (OSError, UnicodeDecodeError, zipfile.BadZipFile, KeyError):
        return {"files": {}, "sheets": [], "findings": [], "profile_accepted": False, "unknown": []}
    unknown = [name for name in files if not _allowed_profile_part(name)]
    try:
        for name, payload in files.items():
            if name.endswith((".xml", ".rels")):
                ElementTree.fromstring(payload)
    except (ElementTree.ParseError, UnicodeDecodeError):
        return {"files": files, "sheets": [], "findings": [], "profile_accepted": False, "unknown": unknown}
    try:
        content_types = files["[Content_Types].xml"].decode("utf-8")
        workbook = files["xl/workbook.xml"]
        profile_accepted = bool(
            workbook
            and "xl/worksheets/sheet1.xml" in files
            and "spreadsheetml.sheet.main+xml" in content_types
            and not unknown
        )
        sheets = _workbook_sheets(files) if workbook else []
    except (KeyError, UnicodeDecodeError):
        return {"files": files, "sheets": [], "findings": [], "profile_accepted": False, "unknown": unknown}
    if not profile_accepted:
        return {"files": files, "sheets": sheets, "findings": [], "profile_accepted": False, "unknown": unknown}
    findings: list[dict[str, Any]] = []
    hidden = [sheet for sheet in sheets if sheet["state"] in {"hidden", "veryhidden"}]
    if hidden:
        findings.append({"mechanism": "hidden_worksheet", "location": "xl/workbook.xml", "count": len(hidden)})
    concealed = _concealed_cells_by_worksheet(files, sheets)
    unresolved = _unresolved_concealed_values_by_worksheet(files, sheets)
    concealed_value_count = sum(len(cells) for cells in concealed.values()) + sum(unresolved.values())
    if concealed_value_count:
        findings.append({"mechanism": "hidden_row_or_column", "location": "xl/worksheets", "count": concealed_value_count})
    return {
        "files": files,
        "sheets": sheets,
        "findings": findings,
        "profile_accepted": True,
        "unknown": unknown,
        "plan": _build_repair_plan(files, sheets, findings, artifact_sha256, unresolved),
    }


def _scan_package(path: Path, artifact_sha256: str) -> dict[str, Any]:
    inspection = _inspect_package(path, artifact_sha256)
    if not inspection["profile_accepted"]:
        return _refusal(
            "scan",
            artifact_sha256,
            "unsupported_container" if not inspection["files"] else "unsupported_content",
        )
    result: dict[str, Any] = {
        "version": API_VERSION,
        "operation": "scan", "status": "findings" if inspection["findings"] else "clean",
        "artifact_sha256": artifact_sha256,
        "engine_version": ENGINE_VERSION,
        "supported_profile": "accepted",
        "findings": inspection["findings"],
    }
    if inspection.get("plan") is not None:
        result["repair_plan"] = inspection["plan"]
    return result


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _repair_plan_hash(plan: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(plan).encode("utf-8")).hexdigest()


def _crc32(payload: bytes) -> int:
    return __import__("binascii").crc32(payload) & 0xFFFFFFFF


def _stored_entry(name: str, payload: bytes) -> tuple[bytes, bytes]:
    encoded_name = name.encode("utf-8")
    checksum = _crc32(payload)
    local = struct.pack(
        "<IHHHHHIIIHH", 0x04034B50, 20, 0, 0, 0, 0, checksum, len(payload), len(payload), len(encoded_name), 0
    ) + encoded_name + payload
    central = struct.pack(
        "<IHHHHHHIIIHHHHHII",
        0x02014B50, 20, 20, 0, 0, 0, 0, checksum, len(payload), len(payload),
        len(encoded_name), 0, 0, 0, 0, 0, 0,
    ) + encoded_name
    return local, central


def _surgical_rewrite(path: Path, changes: dict[str, bytes | None]) -> bytes:
    source = path.read_bytes()
    with zipfile.ZipFile(io.BytesIO(source)) as package:
        infos = package.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)):
            raise ValueError("duplicate ZIP member")
        if any(name not in names and payload is not None for name, payload in changes.items()):
            raise ValueError("repair cannot add a ZIP member")
        central_offset = package.start_dir
        central_raw: dict[str, bytes] = {}
        cursor = central_offset
        for info in infos:
            if source[cursor:cursor + 4] != b"PK\x01\x02":
                raise ValueError("invalid central directory")
            name_length, extra_length, comment_length = struct.unpack_from("<HHH", source, cursor + 28)
            size = 46 + name_length + extra_length + comment_length
            central_raw[info.filename] = source[cursor:cursor + size]
            cursor += size
        ordered_offsets = sorted(info.header_offset for info in infos)
        next_offset = {offset: ordered_offsets[index + 1] if index + 1 < len(ordered_offsets) else central_offset for index, offset in enumerate(ordered_offsets)}
        local_parts: list[bytes] = []
        central_parts: list[bytes] = []
        local_offset = 0
        for info in infos:
            change = changes.get(info.filename, ...)
            if change is None:
                continue
            if change is ...:
                local = source[info.header_offset:next_offset[info.header_offset]]
                central = bytearray(central_raw[info.filename])
            else:
                local, central_bytes = _stored_entry(info.filename, change)
                central = bytearray(central_bytes)
            struct.pack_into("<I", central, 42, local_offset)
            local_parts.append(local)
            central_parts.append(bytes(central))
            local_offset += len(local)
        central_directory = b"".join(central_parts)
        comment = package.comment
    eocd = struct.pack(
        "<IHHHHIIH", 0x06054B50, 0, 0, len(central_parts), len(central_parts), len(central_directory), local_offset, len(comment)
    ) + comment
    return b"".join(local_parts) + central_directory + eocd


def _clear_cell_values(xml: str, cells: list[str]) -> str:
    targets = {
        parsed[0]
        for value in cells
        if (parsed := _cell_info(value)) is not None
    }
    changed: set[str] = set()
    cell_pattern = re.compile(
        rf"(<{_local_element('c')}\b[^>]*>)([\s\S]*?)(</{_local_element('c')}>)|(<{_local_element('c')}\b[^>]*/>)",
        re.IGNORECASE,
    )
    value_pattern = re.compile(
        rf"<{_local_element('f|v|is')}\b[\s\S]*?(?:</{_local_element('f|v|is')}>|/>)",
        re.IGNORECASE,
    )

    def clear(match: re.Match[str]) -> str:
        opening = match.group(1)
        content = match.group(2)
        closing = match.group(3)
        attributes = re.search(rf"<{_local_element('c')}\b([^>]*)", opening or "", re.IGNORECASE)
        reference = _cell_info(_xml_attribute(attributes.group(1), "r") or "")[0] if attributes else None
        if reference is None or reference not in targets:
            return match.group(0)
        if opening is None or content is None or closing is None:
            raise ValueError("concealed cell is not a complete XML element")
        cleared = value_pattern.sub("", content)
        if cleared == content:
            raise ValueError("concealed cell has no clearable value")
        changed.add(reference)
        return opening + cleared + closing

    result = cell_pattern.sub(clear, xml)
    if changed != targets:
        raise ValueError("repair target concealed cell is missing")
    return result


def _repair_package(path: Path, artifact_sha256: str, plan: dict[str, Any]) -> dict[str, Any]:
    inspection = _inspect_package(path, artifact_sha256)
    if not inspection["profile_accepted"] or inspection.get("plan") != plan or plan.get("status") != "eligible":
        return {
            "version": API_VERSION, "operation": "repair", "status": "refused",
            "artifact_sha256": artifact_sha256, "original_artifact_sha256": artifact_sha256,
            "engine_version": ENGINE_VERSION, "repair_plan_sha256": _repair_plan_hash(plan),
            "changed_members": [], "refusal_code": "integrity_failure",
        }
    files: dict[str, bytes] = inspection["files"]
    workbook = files["xl/workbook.xml"].decode("utf-8")
    relationships = files["xl/_rels/workbook.xml.rels"].decode("utf-8")
    content_types = files["[Content_Types].xml"].decode("utf-8")
    changes: dict[str, bytes | None] = {}
    workbook_changed = False
    for action in plan["actions"]:
        if action["kind"] == "clear_hidden_cell_values":
            target = action["target_member"]
            changes[target] = _clear_cell_values(files[target].decode("utf-8"), action["cell_references"]).encode("utf-8")
            continue
        workbook_changed = True
        worksheet_name = action["worksheet"]
        relationship_id = ""

        def remove_sheet(match: re.Match[str]) -> str:
            nonlocal relationship_id
            attributes = match.group(1)
            if _decode_xml(_xml_attribute(attributes, "name") or "") != worksheet_name:
                return match.group(0)
            relationship_id = _xml_attribute(attributes, "r:id") or _xml_attribute(attributes, "id") or ""
            return ""

        workbook = re.sub(rf"<{_local_element('sheet')}\b([^>]*?)(?:/>|>[\s\S]*?</{_local_element('sheet')}>)", remove_sheet, workbook, flags=re.IGNORECASE)
        if not relationship_id:
            raise ValueError("repair worksheet target is missing")

        def remove_relationship(match: re.Match[str]) -> str:
            attributes = match.group(1)
            return "" if _xml_attribute(attributes, "Id") == relationship_id else match.group(0)

        relationships = re.sub(rf"<{_local_element('Relationship')}\b([^>]*?)(?:/>|>[\s\S]*?</{_local_element('Relationship')}>)", remove_relationship, relationships, flags=re.IGNORECASE)
        target = action["target_member"]

        def remove_content_type(match: re.Match[str]) -> str:
            attributes = match.group(1)
            return "" if _normalize_path(_xml_attribute(attributes, "PartName") or "") == target else match.group(0)

        if "[Content_Types].xml" in plan["changed_members"]:
            content_types = re.sub(rf"<{_local_element('Override')}\b([^>]*?)(?:/>|>[\s\S]*?</{_local_element('Override')}>)", remove_content_type, content_types, flags=re.IGNORECASE)
        changes[target] = None
        relationship_part = _worksheet_relationship_member(target)
        if relationship_part in plan["changed_members"]:
            changes[relationship_part] = None
    if workbook_changed:
        changes["xl/workbook.xml"] = workbook.encode("utf-8")
        changes["xl/_rels/workbook.xml.rels"] = relationships.encode("utf-8")
    if "[Content_Types].xml" in plan["changed_members"]:
        changes["[Content_Types].xml"] = content_types.encode("utf-8")
    changed_members = sorted(changes)
    if changed_members != sorted(plan["changed_members"]):
        raise ValueError("repair changed members are not approved")
    repaired = _surgical_rewrite(path, changes)
    REPAIR_OUTPUT = Path(REPAIR_OUTPUT_PATH)
    REPAIR_OUTPUT.write_bytes(repaired)
    candidate_sha256 = hashlib.sha256(repaired).hexdigest()
    return {
        "version": API_VERSION, "operation": "repair", "status": "repaired",
        "artifact_sha256": candidate_sha256, "original_artifact_sha256": artifact_sha256,
        "engine_version": ENGINE_VERSION, "repair_plan_sha256": _repair_plan_hash(plan),
        "changed_members": changed_members,
    }


def _repair_refusal(artifact_sha256: str, refusal_code: str, plan: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "version": API_VERSION,
        "operation": "repair",
        "status": "refused",
        "artifact_sha256": artifact_sha256,
        "original_artifact_sha256": artifact_sha256,
        "engine_version": ENGINE_VERSION,
        "repair_plan_sha256": _repair_plan_hash(plan or {}),
        "changed_members": [],
        "refusal_code": refusal_code,
    }


def _visible_baseline(files: dict[str, bytes]) -> str:
    sheets = [sheet for sheet in _workbook_sheets(files) if sheet["state"] not in {"hidden", "veryhidden"}]
    payload = [
        {
            "name": sheet["name"],
            "path": sheet["path"],
            "xml": base64.b64encode(
                (
                    _clear_cell_values(
                        files[sheet["path"]].decode("utf-8"),
                        _concealed_cells(files[sheet["path"]].decode("utf-8")),
                    )
                    if sheet["path"] in files
                    else ""
                ).encode("utf-8")
            ).decode("ascii"),
        }
        for sheet in sheets
    ]
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _relationships_valid(files: dict[str, bytes]) -> bool:
    return all(not relation["target"] or relation["target"] in files for relation in _relationship_entries(files))


def _content_types_valid(files: dict[str, bytes]) -> bool:
    xml = files.get("[Content_Types].xml", b"").decode("utf-8")
    for match in re.finditer(r"<Override\b([^>]*)/?>(?:</Override>)?", xml, re.IGNORECASE):
        target = _normalize_path(_xml_attribute(match.group(1), "PartName") or "")
        if target and target not in files:
            return False
    return True


def _reopen_readers(path: Path) -> list[str]:
    try:
        with zipfile.ZipFile(path) as package:
            for name in package.namelist():
                if name.endswith((".xml", ".rels")):
                    ElementTree.fromstring(package.read(name))
    except (OSError, KeyError, ElementTree.ParseError, zipfile.BadZipFile):
        return []
    readers = ["python-zipfile", "xml.etree.ElementTree"]
    try:
        openpyxl: Any = importlib.import_module("openpyxl")
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
        workbook.close()
        readers.append("openpyxl")
    except Exception:
        return []
    return readers


def _changed_members(original: dict[str, bytes], candidate: dict[str, bytes]) -> list[str]:
    return sorted(
        set(original) ^ set(candidate)
        | {name for name in set(original) & set(candidate) if original[name] != candidate[name]}
    )


def _approved_worksheet_changes_match(
    original: dict[str, bytes], candidate: dict[str, bytes], plan: dict[str, Any] | None
) -> bool:
    for action in (plan or {}).get("actions", []):
        if action.get("kind") != "clear_hidden_cell_values":
            continue
        target = action.get("target_member")
        if not isinstance(target, str) or target not in original or target not in candidate:
            return False
        expected = _clear_cell_values(
            original[target].decode("utf-8"), action.get("cell_references", [])
        ).encode("utf-8")
        if candidate[target] != expected:
            return False
    return True


def _verify_package(
    path: Path,
    artifact_sha256: str,
    original_artifact_sha256: str,
    original_path: Path | None = None,
    plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    scan = _scan_package(path, artifact_sha256)
    candidate_inspection = _inspect_package(path, artifact_sha256)
    original_inspection = _inspect_package(original_path or path, original_artifact_sha256)
    relationships_valid = bool(candidate_inspection["profile_accepted"] and _relationships_valid(candidate_inspection["files"]))
    content_types_valid = bool(candidate_inspection["profile_accepted"] and _content_types_valid(candidate_inspection["files"]))
    reopened_with = _reopen_readers(path) if candidate_inspection["profile_accepted"] else []
    unchanged = _visible_baseline(original_inspection["files"]) == _visible_baseline(candidate_inspection["files"])
    changed_members = _changed_members(original_inspection["files"], candidate_inspection["files"])
    allowed = set((plan or {}).get("changed_members", []))
    unexplained = sorted(set(changed_members) - allowed)
    approved_contents_match = _approved_worksheet_changes_match(
        original_inspection["files"], candidate_inspection["files"], plan
    )
    changed_members_match = not plan or changed_members == sorted(plan.get("changed_members", []))
    identity_ok = artifact_sha256 != original_artifact_sha256 if plan else artifact_sha256 == original_artifact_sha256
    verified = bool(
        scan["status"] == "clean"
        and candidate_inspection["profile_accepted"]
        and relationships_valid
        and content_types_valid
        and reopened_with
        and unchanged
        and not unexplained
        and approved_contents_match
        and changed_members_match
        and identity_ok
    )
    result: dict[str, Any] = {
        "version": API_VERSION,
        "operation": "verify",
        "status": "verified" if verified else "refused",
        "artifact_sha256": artifact_sha256,
        "original_artifact_sha256": original_artifact_sha256,
        "engine_version": ENGINE_VERSION,
        "artifact_unchanged": unchanged,
        "baseline_sha256": _visible_baseline(original_inspection["files"]),
        "remaining_findings": scan.get("findings", []),
        "relationships_valid": relationships_valid,
        "content_types_valid": content_types_valid,
        "reopened_with": reopened_with,
        "changed_members": changed_members,
        "unexplained_changes": unexplained,
    }
    if not verified:
        result["refusal_code"] = "unsupported_content" if scan["status"] != "clean" or not candidate_inspection["profile_accepted"] else "integrity_failure"
    else:
        shutil.copyfile(path, OUTPUT_PATH)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operation", choices=("scan", "repair", "verify"), required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--original-artifact-sha256")
    parser.add_argument("--original-input", type=Path)
    parser.add_argument("--repair-plan", type=Path)
    args = parser.parse_args()
    actual_sha256 = hashlib.sha256(args.input.read_bytes()).hexdigest()
    if actual_sha256 != args.artifact_sha256:
        result = _repair_refusal(args.artifact_sha256, "integrity_failure") if args.operation == "repair" else _refusal(
            args.operation, args.artifact_sha256, "integrity_failure", original_artifact_sha256=args.original_artifact_sha256
        )
    elif args.operation == "scan":
        result = _scan_package(args.input, args.artifact_sha256)
    elif args.operation == "repair" and args.repair_plan:
        result = _repair_package(args.input, args.artifact_sha256, json.loads(args.repair_plan.read_text(encoding="utf-8")))
    elif args.operation == "repair":
        result = _repair_refusal(args.artifact_sha256, "integrity_failure")
    elif args.original_artifact_sha256:
        plan = json.loads(args.repair_plan.read_text(encoding="utf-8")) if args.repair_plan else None
        result = _verify_package(args.input, args.artifact_sha256, args.original_artifact_sha256, args.original_input, plan)
    else:
        result = _refusal(args.operation, args.artifact_sha256, "integrity_failure")
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
