import base64
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import submission_qualification


def successful_rehearsal() -> dict[str, object]:
    return {
        "schema_version": "1",
        "probe": "live_clean_workbook",
        "status": "disclosed",
        "draft_retrieved": True,
        "draft_envelope_valid": True,
        "artifact_uploaded": True,
        "stage_completed": True,
        "serial_tool_loop_executed": True,
        "trueforge_cerebras_verified": True,
        "daytona_scan_executed": True,
        "daytona_verify_executed": True,
        "native_disclosure_denial_executed": True,
        "smtp_invocations_after_denial": 0,
        "fresh_disclosure_approval_observed": True,
        "approved_disclosure_completed": True,
        "recipient_matching_messages": 1,
        "recipient_confirmation": True,
        "local_python_fallback": False,
        "run_state": "disclosed",
        "artifact_sha256": "a" * 64,
        "model_name": "gemma-4-31b",
        "provider_base_url": "https://api.cerebras.ai/v1",
        "failure_code": "",
    }


def complete_manifest(tmp_path: Path) -> tuple[Path, list[Path]]:
    paths: list[Path] = []
    entries: list[dict[str, object]] = []
    for category in submission_qualification.REQUIRED_PRIVACY_CATEGORIES:
        path = tmp_path / f"{category}.json"
        payload: dict[str, object] = {"status": "ok", "category": category}
        if category == "daytona_artifacts":
            payload["sandbox_destroyed"] = True
        path.write_text(json.dumps(payload), encoding="utf-8")
        paths.append(path)
        entry: dict[str, object] = {"category": category, "path": str(path)}
        if category == "daytona_artifacts":
            entry["destroyed"] = True
        entries.append(entry)
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"schema_version": "1", "entries": entries}), encoding="utf-8")
    return manifest, paths


def test_supported_scope_excludes_open_optional_journeys() -> None:
    assert submission_qualification.SUPPORTED_SCOPE["core_journeys"] == [
        "clean_workbook_disclosure",
        "hidden_worksheet_repair",
    ]
    assert submission_qualification.SUPPORTED_SCOPE["optional_journeys"] == ["gmail_mailbox_trigger"]
    assert "hidden_rows_columns" in submission_qualification.SUPPORTED_SCOPE["cuts"]
    assert "pivot_cache" in submission_qualification.SUPPORTED_SCOPE["cuts"]


def test_rehearsal_acceptance_requires_the_complete_live_journey() -> None:
    accepted, reason = submission_qualification.validate_rehearsal(successful_rehearsal())
    assert accepted is True
    assert reason == ""

    failed = successful_rehearsal()
    failed["smtp_invocations_after_denial"] = 1
    accepted, reason = submission_qualification.validate_rehearsal(failed)
    assert accepted is False
    assert reason == "smtp_activity_after_denial"


def test_two_consecutive_rehearsals_require_unchanged_code_and_configuration() -> None:
    first = successful_rehearsal()
    second = successful_rehearsal()
    snapshots = [
        submission_qualification.RepositorySnapshot("commit", "", "config"),
        submission_qualification.RepositorySnapshot("commit", "", "config"),
        submission_qualification.RepositorySnapshot("commit", "", "config"),
    ]

    result = submission_qualification.qualify_rehearsals([first, second], snapshots)
    assert result["status"] == "demo_ready"
    assert result["rehearsals_completed"] == 2
    assert result["code_unchanged"] is True
    assert result["configuration_unchanged"] is True

    changed = list(snapshots)
    changed[2] = submission_qualification.RepositorySnapshot("new-commit", "", "config")
    result = submission_qualification.qualify_rehearsals([first, second], changed)
    assert result["status"] == "blocked"
    assert result["failure_code"] == "code_changed_between_rehearsals"


def test_privacy_qualification_inspects_all_required_surfaces_and_redacts_failures(tmp_path: Path) -> None:
    manifest, _ = complete_manifest(tmp_path)
    corpus = tmp_path / "private-values.txt"
    corpus.write_text("fictional workbook value\nfictional credential\n", encoding="utf-8")

    result = submission_qualification.qualify_privacy_manifest(manifest, [corpus])
    assert result["status"] == "pass"
    assert result["categories_inspected"] == len(submission_qualification.REQUIRED_PRIVACY_CATEGORIES)
    assert result["forbidden_values_found"] == 0

    transcript = tmp_path / "mcp_transcripts.json"
    transcript.write_text('{"message":"fictional workbook value"}', encoding="utf-8")
    result = submission_qualification.qualify_privacy_manifest(manifest, [corpus])
    assert result["status"] == "blocked"
    assert result["failure_code"] == "forbidden_value_found"

    assert "fictional workbook value" not in json.dumps(result)


def test_privacy_qualification_rejects_prohibited_persistent_fields(tmp_path: Path) -> None:
    manifest, paths = complete_manifest(tmp_path)
    reports = paths[-1]
    reports.write_text('{"draft_body":"not retained"}', encoding="utf-8")
    corpus = tmp_path / "private-values.txt"
    corpus.write_text("private", encoding="utf-8")

    result = submission_qualification.qualify_privacy_manifest(manifest, [corpus])
    assert result["status"] == "blocked"
    assert result["failure_code"] == "prohibited_field"


def test_privacy_qualification_rejects_json_escaped_and_base64_values(tmp_path: Path) -> None:
    manifest, paths = complete_manifest(tmp_path)
    corpus = tmp_path / "private-values.txt"
    corpus.write_text("fictional snowman ☃", encoding="utf-8")

    paths[2].write_text(
        json.dumps({"payload": "fictional snowman ☃"}, ensure_ascii=True), encoding="utf-8"
    )
    result = submission_qualification.qualify_privacy_manifest(manifest, [corpus])
    assert result["status"] == "blocked"
    assert result["failure_code"] == "forbidden_value_found"

    corpus.write_text("fictional credential", encoding="utf-8")
    paths[2].write_text(
        json.dumps({"payload": base64.b64encode(b'{"api_key":"not retained"}').decode("ascii")}),
        encoding="utf-8",
    )
    result = submission_qualification.qualify_privacy_manifest(manifest, [corpus])
    assert result["status"] == "blocked"
    assert result["failure_code"] == "prohibited_field"

    attachment_value = b"fictional attachment bytes"
    corpus.write_bytes(attachment_value)
    paths[2].write_text(
        json.dumps({"payload": base64.b64encode(attachment_value).decode("ascii")}), encoding="utf-8"
    )
    result = submission_qualification.qualify_privacy_manifest(manifest, [corpus])
    assert result["status"] == "blocked"
    assert result["failure_code"] == "forbidden_value_found"


def test_privacy_qualification_rejects_mixed_case_sqlite_prohibited_fields(tmp_path: Path) -> None:
    manifest, _ = complete_manifest(tmp_path)
    sqlite_path = tmp_path / "surface.sqlite"
    with sqlite3.connect(sqlite_path) as database:
        database.execute('CREATE TABLE records ("DRAFT_BODY" TEXT)')
        database.execute("INSERT INTO records VALUES (?)", ("not retained",))
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["entries"][1]["path"] = str(sqlite_path)
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    corpus = tmp_path / "private-values.txt"
    corpus.write_text("private", encoding="utf-8")
    result = submission_qualification.qualify_privacy_manifest(manifest, [corpus])
    assert result["status"] == "blocked"
    assert result["failure_code"] == "prohibited_field"

    with sqlite3.connect(sqlite_path) as database:
        database.execute("DROP TABLE records")
        database.execute("CREATE TABLE records (payload TEXT)")
        database.execute(
            "INSERT INTO records VALUES (?)",
            (base64.b64encode(b'{"api_key":"not retained"}').decode("ascii"),),
        )
    corpus.write_text("private", encoding="utf-8")
    result = submission_qualification.qualify_privacy_manifest(manifest, [corpus])
    assert result["status"] == "blocked"
    assert result["failure_code"] == "prohibited_field"


def test_privacy_qualification_rejects_duplicate_surfaces_and_bad_sqlite(tmp_path: Path) -> None:
    manifest, paths = complete_manifest(tmp_path)
    corpus = tmp_path / "private-values.txt"
    corpus.write_text("private", encoding="utf-8")

    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["entries"][1]["path"] = payload["entries"][0]["path"]
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    result = submission_qualification.qualify_privacy_manifest(manifest, [corpus])
    assert result["status"] == "blocked"
    assert result["failure_code"] == "duplicate_privacy_surface"

    sqlite_path = tmp_path / "invalid.sqlite"
    sqlite_path.write_bytes(b"not a sqlite database")
    payload["entries"][1]["path"] = str(sqlite_path)
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    result = submission_qualification.qualify_privacy_manifest(manifest, [corpus])
    assert result["status"] == "blocked"
    assert result["failure_code"] == "sqlite_unreadable"


def test_repository_hygiene_rejects_workbooks_and_secret_signatures(tmp_path: Path) -> None:
    clean = tmp_path / "README.md"
    clean.write_text("safe", encoding="utf-8")
    assert submission_qualification.check_repository_hygiene([clean]) == []

    workbook = tmp_path / "generated.xlsx"
    workbook.write_bytes(b"PK\x03\x04")
    secret = tmp_path / "config.txt"
    secret.write_text("-----BEGIN " + "PRIVATE" + " KEY" + "-----", encoding="utf-8")
    violations = submission_qualification.check_repository_hygiene([workbook, secret])
    assert "generated_workbook" in violations
    assert "secret_signature" in violations


def test_qualification_docs_state_scope_privacy_and_demo_order() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    runbook = (ROOT / "docs" / "runbook.md").read_text(encoding="utf-8")
    for text in (readme, runbook):
        assert "hidden rows or columns" in text.lower()
        assert "pivot-cache" in text.lower()
        assert "delivery_unknown" in text
        assert "two consecutive rehearsals" in text.lower()
        assert "privacy" in text.lower()
    assert "Sachin" in runbook
    assert "denied Disclosure" in runbook


def test_package_has_mit_license_and_representative_qodo_evidence() -> None:
    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert license_text.startswith("MIT License")
    assert "Copyright (c) 2026 sivaratrisrinivas" in license_text
    for pull_request in (11, 12, 13):
        assert f"/pull/{pull_request}" in readme
        assert "qodo" in readme.lower()
    assert "engineered by Srinivas" in readme
    assert "Sachin" in readme


def test_cli_fails_closed_without_a_privacy_manifest(tmp_path: Path) -> None:
    values = tmp_path / "values.txt"
    values.write_text("private", encoding="utf-8")
    output = tmp_path / "evidence.json"
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "privacy_qualification.py"),
            "--manifest",
            str(tmp_path / "missing.json"),
            "--forbidden-file",
            str(values),
            "--evidence-file",
            str(output),
        ],
        cwd=ROOT,
        env={"PATH": os.environ.get("PATH", "")},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert json.loads(output.read_text(encoding="utf-8"))["status"] == "blocked"


def test_cli_emits_only_bounded_pass_evidence(tmp_path: Path) -> None:
    manifest, _ = complete_manifest(tmp_path)
    corpus = tmp_path / "private-values.txt"
    corpus.write_text("fictional workbook value", encoding="utf-8")
    output = tmp_path / "evidence.json"
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "privacy_qualification.py"),
            "--manifest",
            str(manifest),
            "--forbidden-file",
            str(corpus),
            "--repo-root",
            str(ROOT),
            "--evidence-file",
            str(output),
        ],
        cwd=ROOT,
        env={"PATH": os.environ.get("PATH", "")},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    evidence = json.loads(output.read_text(encoding="utf-8"))
    assert evidence["status"] == "pass"
    assert "fictional workbook value" not in result.stdout
