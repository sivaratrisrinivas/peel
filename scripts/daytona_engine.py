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
    return _normalize_path(f"{directory}/{target}")


def _relationship_entries(files: dict[str, bytes]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for member, payload in files.items():
        if not member.endswith(".rels"):
            continue
        xml = payload.decode("utf-8")
        for match in re.finditer(r"<Relationship\b([^>]*)/?>(?:</Relationship>)?", xml, re.IGNORECASE):
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
    for match in re.finditer(r"<Relationship\b([^>]*)/?>(?:</Relationship>)?", rels, re.IGNORECASE):
        attributes = match.group(1)
        relationship_id = _xml_attribute(attributes, "Id")
        target = _xml_attribute(attributes, "Target")
        if relationship_id and target and (_xml_attribute(attributes, "TargetMode") or "").lower() != "external":
            relationships[relationship_id] = _relationship_target("xl/_rels/workbook.xml.rels", target)
    sheets: list[dict[str, str]] = []
    for match in re.finditer(r"<sheet\b([^>]*)/?>(?:</sheet>)?", workbook, re.IGNORECASE):
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
    name = sheet["name"].replace("'", "''")
    if not name:
        return False
    escaped = re.escape(name)
    return bool(re.search(rf"(?:'{escaped}'|{escaped})!", xml, re.IGNORECASE)) or sheet["path"] in xml


def _matching_element(xml: str, element: str, sheet: dict[str, str]) -> bool:
    return any(_contains_sheet_reference(match.group(0), sheet) for match in re.finditer(rf"<{element}\b[^>]*>[\s\S]*?</{element}>", xml, re.IGNORECASE))


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


def _repair_action(sheet: dict[str, str], files: dict[str, bytes]) -> dict[str, Any]:
    relationship_part = _worksheet_relationship_member(sheet["path"])
    changed = _unique(
        ["[Content_Types].xml", "xl/_rels/workbook.xml.rels", "xl/workbook.xml", sheet["path"]]
        + ([relationship_part] if relationship_part in files else [])
    )
    return {
        "kind": "delete_hidden_worksheet",
        "worksheet": sheet["name"],
        "target_member": sheet["path"],
        "changed_members": changed,
        "capability_losses": [
            f"The hidden worksheet {sheet['name']} and its cell values will be removed.",
            "Workbook behavior that depends on this worksheet was checked and is not included in the supported Repair Plan.",
        ],
    }


def _build_repair_plan(
    files: dict[str, bytes],
    sheets: list[dict[str, str]],
    findings: list[dict[str, Any]],
    artifact_sha256: str,
) -> dict[str, Any] | None:
    hidden = [sheet for sheet in sheets if sheet["state"] in {"hidden", "veryhidden"}]
    if not hidden:
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
    if any(finding["mechanism"] != "hidden_worksheet" for finding in findings):
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
    hidden_rows = 0
    for name, payload in files.items():
        if name.startswith("xl/worksheets/") and name.endswith(".xml"):
            hidden_rows += len(re.findall(r"<(?:row|col)\b[^>]*\bhidden=[\"'](?:1|true)[\"'][^>]*>", payload.decode("utf-8"), re.IGNORECASE))
    if hidden_rows:
        findings.append({"mechanism": "hidden_row_or_column", "location": "xl/worksheets", "count": hidden_rows})
    return {
        "files": files,
        "sheets": sheets,
        "findings": findings,
        "profile_accepted": True,
        "unknown": unknown,
        "plan": _build_repair_plan(files, sheets, findings, artifact_sha256),
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
    for action in plan["actions"]:
        worksheet_name = action["worksheet"]
        relationship_id = ""

        def remove_sheet(match: re.Match[str]) -> str:
            nonlocal relationship_id
            attributes = match.group(1)
            if _decode_xml(_xml_attribute(attributes, "name") or "") != worksheet_name:
                return match.group(0)
            relationship_id = _xml_attribute(attributes, "r:id") or _xml_attribute(attributes, "id") or ""
            return ""

        workbook = re.sub(r"<sheet\b([^>]*?)(?:/>|>[\s\S]*?</sheet>)", remove_sheet, workbook, flags=re.IGNORECASE)
        if not relationship_id:
            raise ValueError("repair worksheet target is missing")

        def remove_relationship(match: re.Match[str]) -> str:
            attributes = match.group(1)
            return "" if _xml_attribute(attributes, "Id") == relationship_id else match.group(0)

        relationships = re.sub(r"<Relationship\b([^>]*?)(?:/>|>[\s\S]*?</Relationship>)", remove_relationship, relationships, flags=re.IGNORECASE)
        target = action["target_member"]

        def remove_content_type(match: re.Match[str]) -> str:
            attributes = match.group(1)
            return "" if _normalize_path(_xml_attribute(attributes, "PartName") or "") == target else match.group(0)

        content_types = re.sub(r"<Override\b([^>]*?)(?:/>|>[\s\S]*?</Override>)", remove_content_type, content_types, flags=re.IGNORECASE)
        changes[target] = None
        relationship_part = _worksheet_relationship_member(target)
        if relationship_part in plan["changed_members"]:
            changes[relationship_part] = None
    changes["xl/workbook.xml"] = workbook.encode("utf-8")
    changes["xl/_rels/workbook.xml.rels"] = relationships.encode("utf-8")
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
            "xml": base64.b64encode(files.get(sheet["path"], b"")).decode("ascii"),
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
        pass
    return readers


def _changed_members(original: dict[str, bytes], candidate: dict[str, bytes]) -> list[str]:
    return sorted(
        set(original) ^ set(candidate)
        | {name for name in set(original) & set(candidate) if original[name] != candidate[name]}
    )


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
