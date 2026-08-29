#!/usr/bin/env python3
"""Validate the bounded evidence and privacy claims for the Peel submission."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import sqlite3
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = "1"
SUPPORTED_MODEL_NAMES = {"gpt-oss-120b", "gemma-4-31b"}
REQUIRED_PRIVACY_CATEGORIES = [
    "logs",
    "sqlite",
    "trueforge_events",
    "cerebras_requests",
    "mcp_transcripts",
    "daytona_artifacts",
    "reports",
]
SUPPORTED_SCOPE: dict[str, list[str] | dict[str, str]] = {
    "core_journeys": ["clean_workbook_disclosure", "hidden_worksheet_repair"],
    "optional_journeys": ["gmail_mailbox_trigger"],
    "cuts": {
        "hidden_rows_columns": "cut: optional issue #8 is open and not qualified",
        "pivot_cache": "cut: optional issue #9 is open and no trusted pivot fixture is qualified",
        "sensitive_reveal_values": "cut: metadata-only policy until private retention is proven",
        "libreoffice_reopen": "cut: no supported binary was qualified in the demonstrated environment",
    },
}

REHEARSAL_BOOLEAN_FIELDS = [
    "draft_retrieved",
    "draft_envelope_valid",
    "artifact_uploaded",
    "stage_completed",
    "serial_tool_loop_executed",
    "trueforge_cerebras_verified",
    "daytona_scan_executed",
    "daytona_verify_executed",
    "native_disclosure_denial_executed",
    "fresh_disclosure_approval_observed",
    "approved_disclosure_completed",
    "recipient_confirmation",
]
FORBIDDEN_JSON_KEYS = {
    "draft_body",
    "raw_body",
    "message_body",
    "reveal",
    "reveal_sample",
    "reveal_values",
    "workbook_values",
    "cell_values",
    "attachment_bytes",
    "raw_attachment",
    "password",
    "api_key",
    "access_token",
    "secret",
    "credential",
    "credentials",
}
FORBIDDEN_JSON_KEYS_CASEFOLD = {key.casefold() for key in FORBIDDEN_JSON_KEYS}
FORBIDDEN_KEY_PATTERN = re.compile(
    rb'"(?:draft_body|raw_body|message_body|reveal(?:_sample|_values)?|'
    rb"workbook_values|cell_values|attachment_bytes|raw_attachment|password|"
    rb'api_key|access_token|secret|credential|credentials)\s*:',
    re.IGNORECASE,
)
SECRET_SIGNATURES = (
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", re.IGNORECASE),
    re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(rb"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(rb"\bsk-[A-Za-z0-9]{20,}\b"),
)
WORKBOOK_SUFFIXES = {".xlsx", ".xlsm", ".xlsb"}
CONFIGURATION_NAMES = (
    "CEREBRAS_API_KEY",
    "TRUEFORGE_API_KEY",
    "DAYTONA_API_KEY",
    "DAYTONA_API_URL",
    "DAYTONA_TARGET",
    "DAYTONA_SNAPSHOT",
    "IMAP_HOST",
    "IMAP_USERNAME",
    "IMAP_PASSWORD",
    "IMAP_PORT",
    "IMAP_DRAFTS_MAILBOX",
    "SMTP_HOST",
    "SMTP_USERNAME",
    "SMTP_PASSWORD",
    "SMTP_PORT",
    "PEEL_OWNED_RECIPIENT",
    "PEEL_RECIPIENT_IMAP_HOST",
    "PEEL_RECIPIENT_IMAP_USERNAME",
    "PEEL_RECIPIENT_IMAP_PASSWORD",
    "PEEL_RECIPIENT_IMAP_PORT",
    "PEEL_RECIPIENT_IMAP_MAILBOX",
    "PEEL_TRUEFORGE_URL",
    "PEEL_TRUEFORGE_MODEL",
    "PEEL_NODE_BIN",
    "PEEL_PYTHON_BIN",
)
MAX_INSPECTED_FILE_BYTES = 128 * 1024 * 1024
MAX_SERIALIZED_VALUE_BYTES = 4 * 1024 * 1024
MAX_JSON_INSPECTION_DEPTH = 32


@dataclass(frozen=True)
class RepositorySnapshot:
    """Code, worktree, and configuration identity held only during qualification."""

    commit: str
    status: str
    configuration_fingerprint: str


def validate_rehearsal(evidence: Mapping[str, object]) -> tuple[bool, str]:
    """Validate one live clean-workbook evidence record at its public boundary."""

    if evidence.get("schema_version") != SCHEMA_VERSION or evidence.get("probe") != "live_clean_workbook":
        return False, "invalid_rehearsal_schema"
    for field in REHEARSAL_BOOLEAN_FIELDS:
        if evidence.get(field) is not True:
            return False, f"missing_{field}"
    if evidence.get("status") != "disclosed" or evidence.get("run_state") != "disclosed":
        return False, "journey_not_disclosed"
    if evidence.get("smtp_invocations_after_denial") != 0:
        return False, "smtp_activity_after_denial"
    if evidence.get("recipient_matching_messages") != 1:
        return False, "recipient_confirmation_not_unique"
    if evidence.get("local_python_fallback") is not False:
        return False, "local_python_fallback"
    if evidence.get("model_name") not in SUPPORTED_MODEL_NAMES:
        return False, "unsupported_model"
    if evidence.get("provider_base_url") != "https://api.cerebras.ai/v1":
        return False, "unexpected_provider"
    artifact_sha256 = evidence.get("artifact_sha256")
    if not isinstance(artifact_sha256, str) or re.fullmatch(r"[0-9a-f]{64}", artifact_sha256) is None:
        return False, "invalid_artifact_identity"
    if evidence.get("failure_code") != "":
        return False, "journey_failure_code"
    return True, ""


def qualify_rehearsals(
    evidences: Sequence[Mapping[str, object]], snapshots: Sequence[RepositorySnapshot]
) -> dict[str, object]:
    """Require two valid rehearsals and an unchanged code/config snapshot around both."""

    result: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "probe": "submission_rehearsal",
        "status": "blocked",
        "rehearsals_completed": 0,
        "code_unchanged": False,
        "configuration_unchanged": False,
        "failure_code": "",
    }
    if len(evidences) != 2 or len(snapshots) != 3:
        result["failure_code"] = "exactly_two_rehearsals_required"
        return result
    completed = 0
    for evidence in evidences:
        accepted, reason = validate_rehearsal(evidence)
        if not accepted:
            result["failure_code"] = reason
            return result
        completed += 1
    result["rehearsals_completed"] = completed

    first = snapshots[0]
    code_unchanged = all(snapshot.commit == first.commit for snapshot in snapshots)
    configuration_unchanged = all(
        snapshot.configuration_fingerprint == first.configuration_fingerprint for snapshot in snapshots
    )
    clean_between = all(snapshot.status == "" for snapshot in snapshots)
    result["code_unchanged"] = code_unchanged and clean_between
    result["configuration_unchanged"] = configuration_unchanged
    if not code_unchanged:
        result["failure_code"] = "code_changed_between_rehearsals"
    elif not configuration_unchanged:
        result["failure_code"] = "configuration_changed_between_rehearsals"
    elif not clean_between:
        result["failure_code"] = "working_tree_changed_between_rehearsals"
    else:
        result["status"] = "demo_ready"
    return result


def configuration_fingerprint(repo_root: Path) -> str:
    """Hash local configuration for equality checks without returning its values."""

    digest = hashlib.sha256()
    for name in CONFIGURATION_NAMES:
        digest.update(name.encode("utf-8"))
        digest.update(b"=")
        digest.update(os.environ.get(name, "").encode("utf-8"))
        digest.update(b"\0")
    dotenv = repo_root / ".env"
    if dotenv.is_file():
        digest.update(b".env\0")
        digest.update(dotenv.read_bytes())
    return digest.hexdigest()


def repository_snapshot(repo_root: Path) -> RepositorySnapshot:
    """Capture repository identity while keeping command output out of evidence."""

    def git_output(arguments: list[str], fallback: str) -> str:
        try:
            completed = subprocess.run(
                ["git", *arguments],
                cwd=repo_root,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return fallback
        return completed.stdout.strip() if completed.returncode == 0 else fallback

    return RepositorySnapshot(
        commit=git_output(["rev-parse", "HEAD"], "git-unavailable"),
        status=git_output(["status", "--porcelain", "--untracked-files=all"], "git-unavailable"),
        configuration_fingerprint=configuration_fingerprint(repo_root),
    )


def tracked_paths(repo_root: Path) -> list[Path]:
    """Return tracked files without exposing Git output in a report."""

    try:
        completed = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=repo_root,
            capture_output=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise OSError("tracked file listing unavailable") from error
    if completed.returncode != 0:
        raise OSError("tracked file listing unavailable")
    return [repo_root / item for item in completed.stdout.decode("utf-8", errors="surrogateescape").split("\0") if item]


def check_repository_hygiene(paths: Sequence[Path]) -> list[str]:
    """Check a tracked-file set for generated workbooks and common secret signatures."""

    violations: set[str] = set()
    for path in paths:
        if path.suffix.lower() in WORKBOOK_SUFFIXES:
            violations.add("generated_workbook")
        if path.name == ".env":
            violations.add("tracked_env")
        try:
            data = path.read_bytes()
        except OSError:
            violations.add("unreadable_tracked_file")
            continue
        if len(data) > MAX_INSPECTED_FILE_BYTES:
            violations.add("tracked_file_too_large")
            continue
        if any(pattern.search(data) for pattern in SECRET_SIGNATURES):
            violations.add("secret_signature")
    return sorted(violations)


def _read_needles(paths: Sequence[Path]) -> list[bytes]:
    needles: list[bytes] = []
    for path in paths:
        data = path.read_bytes()
        if not data:
            continue
        needles.append(data)
        for line in data.splitlines():
            line = line.strip()
            if line:
                needles.append(line)
    return needles


def _needle_variants(needles: Sequence[bytes]) -> list[bytes]:
    """Build encoded forms that can occur in JSON, SQLite, or serialized payloads."""

    variants: set[bytes] = set(needles)
    for needle in needles:
        try:
            text = needle.decode("utf-8")
        except UnicodeDecodeError:
            text = ""
        if text:
            variants.add(json.dumps(text, ensure_ascii=True).encode("utf-8"))
            variants.add(json.dumps(text, ensure_ascii=False).encode("utf-8"))
        variants.add(base64.b64encode(needle))
        variants.add(base64.urlsafe_b64encode(needle))
    return sorted(variants, key=len, reverse=True)


def _iter_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    if path.is_dir():
        return sorted(candidate for candidate in path.rglob("*") if candidate.is_file())
    return []


class _SerializedInspectionLimit(Exception):
    """Raised when a structured value exceeds the bounded privacy inspection."""


def _parse_json_payload(data: bytes) -> object | None:
    if len(data) > MAX_SERIALIZED_VALUE_BYTES:
        if data.lstrip()[:1] in {b"{", b"["}:
            raise _SerializedInspectionLimit
        return None
    try:
        return json.loads(data)
    except (ValueError, UnicodeDecodeError):
        return None
    except RecursionError as error:
        raise _SerializedInspectionLimit from error


def _serialized_json_payloads(value: bytes) -> list[object]:
    payloads: list[object] = []
    direct = _parse_json_payload(value)
    if direct is not None:
        payloads.append(direct)
    encoded = _decode_base64(value)
    if encoded is not None:
        decoded = _parse_json_payload(encoded)
        if decoded is not None:
            payloads.append(decoded)
    return payloads


def _json_has_prohibited_field(value: object, *, depth: int = 0) -> bool:
    if depth > MAX_JSON_INSPECTION_DEPTH:
        raise _SerializedInspectionLimit
    if isinstance(value, dict):
        if any(str(key).casefold() in FORBIDDEN_JSON_KEYS_CASEFOLD for key in value):
            return True
        return any(_json_has_prohibited_field(item, depth=depth + 1) for item in value.values())
    if isinstance(value, list):
        return any(_json_has_prohibited_field(item, depth=depth + 1) for item in value)
    if isinstance(value, str):
        return any(
            _json_has_prohibited_field(item, depth=depth + 1)
            for item in _serialized_json_payloads(value.encode("utf-8"))
        )
    return False


def _decode_base64(value: bytes) -> bytes | None:
    if len(value) < 8:
        return None
    if len(value) > MAX_SERIALIZED_VALUE_BYTES:
        raise _SerializedInspectionLimit
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        try:
            decoded = base64.urlsafe_b64decode(value + b"=" * (-len(value) % 4))
        except (binascii.Error, ValueError):
            return None
    return decoded if decoded else None


def _serialized_value_contains_needle(value: bytes, needles: Sequence[bytes]) -> bool:
    if _contains_needle(value, needles):
        return True
    decoded = _decode_base64(value)
    return decoded is not None and _contains_needle(decoded, needles)


def _json_contains_prohibited_value(value: object, needles: Sequence[bytes], *, depth: int = 0) -> bool:
    if depth > MAX_JSON_INSPECTION_DEPTH:
        raise _SerializedInspectionLimit
    if isinstance(value, dict):
        return any(_json_contains_prohibited_value(item, needles, depth=depth + 1) for item in value.values())
    if isinstance(value, list):
        return any(_json_contains_prohibited_value(item, needles, depth=depth + 1) for item in value)
    if isinstance(value, str):
        serialized = value.encode("utf-8")
        return _serialized_value_contains_needle(serialized, needles) or any(
            _json_contains_prohibited_value(item, needles, depth=depth + 1)
            for item in _serialized_json_payloads(serialized)
        )
    return False


def _sqlite_inspection(path: Path, needles: Sequence[bytes]) -> tuple[bool, bool]:
    prohibited_field = False
    prohibited_value = False
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as database:
        tables = [row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        for table in tables:
            identifier = '"' + str(table).replace('"', '""') + '"'
            columns = [row[1] for row in database.execute(f"PRAGMA table_info({identifier})")]
            if any(str(column).casefold() in FORBIDDEN_JSON_KEYS_CASEFOLD for column in columns):
                prohibited_field = True
            for row in database.execute(f"SELECT * FROM {identifier}"):
                for value in row:
                    serialized = (
                        value
                        if isinstance(value, bytes)
                        else value.encode("utf-8")
                        if isinstance(value, str)
                        else str(value).encode("utf-8")
                        if isinstance(value, (int, float))
                        else None
                    )
                    if serialized is None:
                        continue
                    if _serialized_value_contains_needle(serialized, needles):
                        prohibited_value = True
                    if any(_json_has_prohibited_field(item) for item in _serialized_json_payloads(serialized)):
                        prohibited_field = True
    return prohibited_field, prohibited_value


def _contains_needle(data: bytes, needles: Sequence[bytes]) -> bool:
    return any(needle in data for needle in needles)


def _failure(code: str, *, categories_inspected: int = 0) -> dict[str, object]:
    return {
        "schema_version": SCHEMA_VERSION,
        "probe": "privacy_qualification",
        "status": "blocked",
        "categories_inspected": categories_inspected,
        "forbidden_values_found": 0,
        "prohibited_fields_found": 0,
        "repository_hygiene": "not_checked",
        "failure_code": code,
    }


def qualify_privacy_manifest(manifest_path: Path, forbidden_files: Sequence[Path]) -> dict[str, object]:
    """Inspect all persisted observation surfaces without returning their contents or paths."""

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return _failure("manifest_unreadable")
    if not isinstance(manifest, dict) or manifest.get("schema_version") != SCHEMA_VERSION:
        return _failure("invalid_manifest_schema")
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        return _failure("manifest_entries_missing")
    needles: list[bytes]
    try:
        needles = _read_needles(forbidden_files)
    except OSError:
        return _failure("forbidden_corpus_unreadable")
    if not needles:
        return _failure("forbidden_corpus_empty")
    encoded_needles = _needle_variants(needles)

    categories: set[str] = set()
    surface_paths: set[Path] = set()
    files: list[Path] = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("category"), str) or not isinstance(entry.get("path"), str):
            return _failure("invalid_manifest_entry", categories_inspected=len(categories))
        category = entry["category"]
        if category not in REQUIRED_PRIVACY_CATEGORIES:
            return _failure("unknown_privacy_category", categories_inspected=len(categories))
        if category == "daytona_artifacts" and entry.get("destroyed") is not True:
            return _failure("daytona_cleanup_unproven", categories_inspected=len(categories))
        path = Path(entry["path"])
        entry_files = _iter_files(path)
        if not entry_files:
            return _failure("privacy_surface_missing", categories_inspected=len(categories))
        resolved_path = path.resolve()
        if resolved_path in surface_paths:
            return _failure("duplicate_privacy_surface", categories_inspected=len(categories))
        surface_paths.add(resolved_path)
        if category == "daytona_artifacts":
            metadata_cleanup_proven = False
            for metadata_path in entry_files:
                if metadata_path.suffix.lower() != ".json":
                    continue
                try:
                    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                except (OSError, ValueError, UnicodeDecodeError):
                    continue
                if isinstance(metadata, dict) and (
                    metadata.get("sandbox_destroyed") is True or metadata.get("destroyed") is True
                ):
                    metadata_cleanup_proven = True
                    break
            if not metadata_cleanup_proven:
                return _failure("daytona_cleanup_unproven", categories_inspected=len(categories))
        categories.add(category)
        files.extend(entry_files)
    missing = set(REQUIRED_PRIVACY_CATEGORIES) - categories
    if missing:
        return _failure("privacy_surface_missing", categories_inspected=len(categories))

    prohibited_values = 0
    prohibited_fields = 0
    for path in files:
        try:
            data = path.read_bytes()
        except OSError:
            return _failure("privacy_surface_unreadable", categories_inspected=len(categories))
        if len(data) > MAX_INSPECTED_FILE_BYTES:
            return _failure("privacy_surface_too_large", categories_inspected=len(categories))
        if _contains_needle(data, encoded_needles):
            prohibited_values += 1
        if FORBIDDEN_KEY_PATTERN.search(data):
            prohibited_fields += 1
        if path.suffix.lower() == ".json":
            try:
                decoded_json = json.loads(data)
                if _json_has_prohibited_field(decoded_json):
                    prohibited_fields += 1
                if _json_contains_prohibited_value(decoded_json, needles):
                    prohibited_values += 1
            except _SerializedInspectionLimit:
                return _failure("privacy_surface_too_complex", categories_inspected=len(categories))
            except RecursionError:
                return _failure("privacy_surface_too_complex", categories_inspected=len(categories))
            except (ValueError, UnicodeDecodeError):
                pass
        if path.suffix.lower() in {".sqlite", ".db"}:
            try:
                sqlite_has_prohibited_field, sqlite_has_prohibited_value = _sqlite_inspection(path, needles)
            except _SerializedInspectionLimit:
                return _failure("privacy_surface_too_complex", categories_inspected=len(categories))
            except (OSError, sqlite3.Error):
                return _failure("sqlite_unreadable", categories_inspected=len(categories))
            if sqlite_has_prohibited_field:
                prohibited_fields += 1
            if sqlite_has_prohibited_value:
                prohibited_values += 1
    if prohibited_values:
        return _failure("forbidden_value_found", categories_inspected=len(categories)) | {
            "forbidden_values_found": prohibited_values
        }
    if prohibited_fields:
        return _failure("prohibited_field", categories_inspected=len(categories)) | {
            "prohibited_fields_found": prohibited_fields
        }
    return {
        "schema_version": SCHEMA_VERSION,
        "probe": "privacy_qualification",
        "status": "pass",
        "categories_inspected": len(categories),
        "forbidden_values_found": 0,
        "prohibited_fields_found": 0,
        "repository_hygiene": "not_checked",
        "failure_code": "",
    }


def write_evidence(path: Path, evidence: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(dict(evidence), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--forbidden-file", action="append", required=True, type=Path)
    parser.add_argument("--repo-root", default=".", type=Path)
    parser.add_argument("--evidence-file", required=True, type=Path)
    args = parser.parse_args()

    evidence = qualify_privacy_manifest(args.manifest, args.forbidden_file)
    try:
        hygiene = check_repository_hygiene(tracked_paths(args.repo_root))
    except OSError:
        hygiene = ["tracked_file_listing_unavailable"]
    evidence["repository_hygiene"] = "pass" if not hygiene else "blocked"
    if hygiene and evidence["status"] == "pass":
        evidence["status"] = "blocked"
        evidence["failure_code"] = "repository_hygiene"
    write_evidence(args.evidence_file, evidence)
    print(json.dumps(evidence, sort_keys=True))
    return 0 if evidence["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
