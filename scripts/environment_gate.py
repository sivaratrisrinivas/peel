#!/usr/bin/env python3
"""Run Peel's pre-implementation environment gate.

The gate is deliberately conservative. It records only booleans, identifiers,
and bounded metadata; command output and environment values are never copied
into the report. A mandatory integration is a pass only after its live proof
has actually been observed, not merely because a credential is configured.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any, Sequence


REPO_DEFAULT = "sivaratrisrinivas/peel"
SCHEMA_VERSION = "1"
SUPPORTED_TRUEFORGE_CEREBRAS_MODELS = {"gpt-oss-120b", "gemma-4-31b"}


def _capture(command: Sequence[str], timeout: float = 8.0) -> tuple[bool, str, str]:
    """Run a probe command while keeping its output inside the probe."""

    try:
        result = subprocess.run(
            list(command),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return False, "", "unavailable"
    return result.returncode == 0, result.stdout, result.stderr


def _run(command: Sequence[str], timeout: float = 8.0) -> bool:
    """Run a probe command without returning its output to the caller."""

    succeeded, _, _ = _capture(command, timeout)
    return succeeded


def _command_path(name: str) -> str | None:
    """Find a command on PATH or in the conventional user-local bin directory."""

    return shutil.which(name) or next(
        (
            str(candidate)
            for candidate in (Path.home() / ".local" / "bin" / name,)
            if candidate.is_file() and candidate.stat().st_mode & 0o111
        ),
        None,
    )


def _git_head(root: Path) -> str | None:
    """Return the current checkout commit without exposing command output in reports."""

    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None
    commit = result.stdout.strip()
    return commit if result.returncode == 0 and re.fullmatch(r"[0-9a-fA-F]{40}", commit) else None


def _module_present(name: str) -> bool:
    """Return module availability without turning a missing parent into a crash."""

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def _load_dotenv(path: Path) -> None:
    """Load simple dotenv entries without executing the file as shell code."""

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("export "):
            line = line[7:].lstrip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        value = value.strip()
        for escaped_line_end in (r"\r\n", r"\r", r"\n"):
            if value.endswith(escaped_line_end):
                value = value[: -len(escaped_line_end)].rstrip()
        os.environ.setdefault(name, value)


def _read_probe_evidence(environment_name: str, expected_probe: str) -> dict[str, Any]:
    """Read a bounded, locally generated live-proof record without exposing its contents."""

    path_value = os.environ.get(environment_name)
    if not path_value:
        return {}
    try:
        raw = json.loads(Path(path_value).read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return {}
    if (
        not isinstance(raw, dict)
        or raw.get("schema_version") != SCHEMA_VERSION
        or raw.get("probe") != expected_probe
    ):
        return {}
    return raw


def _evidence_bool(evidence: dict[str, Any], name: str) -> bool:
    """Accept only literal booleans from a live-proof record."""

    return evidence.get(name) is True


def _evidence_false(evidence: dict[str, Any], name: str) -> bool:
    """Require an explicit false value for a negative safety assertion."""

    return evidence.get(name) is False


def _evidence_string(evidence: dict[str, Any], name: str) -> str | None:
    """Accept only strings from a live-proof record; never echo the value in reports."""

    value = evidence.get(name)
    return value if isinstance(value, str) else None


def _daytona_sdk_usable() -> bool:
    """Check the exact Daytona SDK symbols imported by the live probe."""

    try:
        from daytona import CreateSandboxFromSnapshotParams, Daytona, DaytonaConfig
    except Exception:
        return False
    return all(callable(symbol) for symbol in (CreateSandboxFromSnapshotParams, Daytona, DaytonaConfig))


def _gate(
    name: str,
    mandatory: bool,
    status: str,
    summary: str,
    evidence: dict[str, Any],
) -> dict[str, Any]:
    if status not in {"pass", "fail", "cut"}:
        raise ValueError(f"invalid gate status: {status}")
    return {
        "name": name,
        "mandatory": mandatory,
        "status": status,
        "summary": summary,
        "evidence": evidence,
    }


def _env_present(names: Sequence[str]) -> bool:
    return all(bool(os.environ.get(name)) for name in names)


def _qodo_findings_resolved(comments: list[dict[str, Any]], commit: str) -> bool:
    """Require the newest canonical Qodo review for the target commit to be resolved."""

    finding_summaries = re.compile(r"<summary>\s+\d+\.\s+.*?</summary>", re.DOTALL)
    candidates: list[tuple[str, int, list[str]]] = []
    for comment in comments:
        login = comment.get("login")
        body = comment.get("body")
        if (
            not isinstance(login, str)
            or "qodo" not in login.lower()
            or not isinstance(body, str)
            or "<h3>Code Review by Qodo</h3>" not in body
            or commit not in body
        ):
            continue
        summaries = finding_summaries.findall(body)
        if not summaries:
            continue
        timestamp = comment.get("updated_at") or comment.get("created_at")
        if not isinstance(timestamp, str):
            timestamp = ""
        comment_id = comment.get("id")
        candidates.append((timestamp, comment_id if isinstance(comment_id, int) else -1, summaries))
    if not candidates:
        return False
    _, _, latest_summaries = max(candidates, key=lambda candidate: (candidate[0], candidate[1]))
    return all("✓ Resolved" in summary for summary in latest_summaries)


def _probe_github_qodo(
    repo: str,
    offline: bool,
    pull_request_number: int | None = None,
    expected_commit: str | None = None,
) -> dict[str, Any]:
    gh_path = _command_path("gh")
    evidence: dict[str, Any] = {
        "repo": repo,
        "offline": offline,
        "gh_available": gh_path is not None,
        "authenticated": False,
        "public_repo": False,
        "pull_request_number": pull_request_number,
        "pull_request_open": False,
        "head_commit_verified": False,
        "qodo_review_found": False,
        "qodo_review_commit_verified": False,
        "qodo_findings_resolved": False,
    }

    if offline:
        return _gate(
            "github_qodo",
            True,
            "fail",
            "Offline mode prevented the public-repository and Qodo review probe.",
            evidence,
        )
    if not evidence["gh_available"]:
        return _gate(
            "github_qodo",
            True,
            "fail",
            "GitHub CLI is unavailable, so Qodo access and review cannot be proved.",
            evidence,
        )

    if gh_path is None:
        return _gate(
            "github_qodo",
            True,
            "fail",
            "GitHub CLI is unavailable, so Qodo access and review cannot be proved.",
            evidence,
        )

    # `gh auth status` exits nonzero when any unrelated inactive account is
    # configured on the host. The authenticated API identity is the probe we
    # actually need, and `--silent` prevents account metadata from leaking.
    authenticated, _, _ = _capture([gh_path, "api", "user", "--silent"])
    evidence["authenticated"] = authenticated
    if not authenticated:
        return _gate(
            "github_qodo",
            True,
            "fail",
            "GitHub authentication failed; Qodo review was not verified.",
            evidence,
        )

    public_probe, public_value, _ = _capture([gh_path, "api", f"repos/{repo}", "--jq", ".private"])
    public_repo = public_probe and public_value.strip() == "false"
    evidence["public_repo"] = public_repo
    if not public_repo:
        return _gate(
            "github_qodo",
            True,
            "fail",
            "The public repository probe failed; Qodo review was not verified.",
            evidence,
        )

    if pull_request_number is None or expected_commit is None:
        return _gate(
            "github_qodo",
            True,
            "fail",
            "A target pull request and current checkout commit are required for reproducible Qodo evidence.",
            evidence,
        )

    pr_probe, pr_output, _ = _capture(
        [
            gh_path,
            "api",
            f"repos/{repo}/pulls/{pull_request_number}",
            "--jq",
            "{number,state,head_sha:.head.sha}",
        ],
        timeout=15,
    )
    try:
        pull_request = json.loads(pr_output) if pr_probe else {}
    except json.JSONDecodeError:
        pull_request = {}
    evidence["pull_request_open"] = (
        isinstance(pull_request, dict)
        and pull_request.get("number") == pull_request_number
        and pull_request.get("state") == "open"
    )
    evidence["head_commit_verified"] = (
        evidence["pull_request_open"] and pull_request.get("head_sha") == expected_commit
    )
    if not evidence["head_commit_verified"]:
        return _gate(
            "github_qodo",
            True,
            "fail",
            "The target pull request is not open at the current checkout commit.",
            evidence,
        )

    reviewed, review_output, _ = _capture(
        [
            gh_path,
            "api",
            f"repos/{repo}/pulls/{pull_request_number}/reviews",
            "--paginate",
            "--jq",
            ".[] | {login:.user.login,state,commit_id}",
        ],
        timeout=15,
    )
    review_records: list[dict[str, Any]] = []
    if reviewed:
        for line in review_output.splitlines():
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                review_records.append(record)
    qodo_reviews = [
        record
        for record in review_records
        if isinstance(record.get("login"), str) and "qodo" in record["login"].lower()
    ]
    evidence["qodo_review_found"] = bool(qodo_reviews)
    evidence["qodo_review_commit_verified"] = any(
        record.get("commit_id") == expected_commit
        and record.get("state") in {"COMMENTED", "APPROVED", "CHANGES_REQUESTED"}
        for record in qodo_reviews
    )

    comments_ok, comments_output, _ = _capture(
        [
            gh_path,
            "api",
            f"repos/{repo}/issues/{pull_request_number}/comments",
            "--paginate",
            "--jq",
            (
                ".[] | select(.user.login | ascii_downcase | contains(\"qodo\")) | "
                "{id,created_at,updated_at,login:.user.login,body:.body}"
            ),
        ],
        timeout=15,
    )
    comments: list[dict[str, Any]] = []
    if comments_ok:
        for line in comments_output.splitlines():
            try:
                comment = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(comment, dict):
                comments.append(comment)
    evidence["qodo_findings_resolved"] = _qodo_findings_resolved(comments, expected_commit)

    status = "pass" if all(
        evidence[key]
        for key in (
            "qodo_review_found",
            "qodo_review_commit_verified",
            "qodo_findings_resolved",
        )
    ) else "fail"
    summary = (
        (
            "Public repository, target pull request, current commit, and fully resolved "
            "Qodo review evidence verified."
        )
        if status == "pass"
        else "Public repository was reachable, but target-commit Qodo review evidence was incomplete."
    )
    return _gate("github_qodo", True, status, summary, evidence)


def _probe_trueforge_cerebras() -> dict[str, Any]:
    credentials = _env_present(("CEREBRAS_API_KEY", "TRUEFORGE_API_KEY"))
    adapter = any(_command_path(command) for command in ("trueforge", "cerebras", "npx"))
    sdk_present = _module_present("cerebras.cloud.sdk")
    proof = _read_probe_evidence("PEEL_TRUEFORGE_EVIDENCE_FILE", "trueforge_cerebras")
    required_proof = {
        "serial_tool_loop_executed": _evidence_bool(proof, "serial_tool_loop_executed"),
        "native_denial_executed": _evidence_bool(proof, "native_denial_executed"),
        "denied_tool_name": _evidence_string(proof, "denied_tool_name") == "send_email",
        "side_effects_checked": _evidence_bool(proof, "side_effects_checked"),
        "side_effects_observed": _evidence_bool(proof, "side_effects_observed"),
        "parallel_tool_calls": proof.get("parallel_tool_calls") is False,
        "response_format_on_tool_turn": _evidence_bool(proof, "response_format_on_tool_turn"),
        "runtime_identity_verified": _evidence_bool(proof, "runtime_identity_verified"),
        "model_name": _evidence_string(proof, "model_name") in SUPPORTED_TRUEFORGE_CEREBRAS_MODELS,
        "provider_base_url": _evidence_string(proof, "provider_base_url") == "https://api.cerebras.ai/v1",
    }
    evidence = {
        "credentials_present": credentials,
        "runtime_adapter_present": adapter,
        "cerebras_sdk_present": sdk_present,
        "evidence_file_present": bool(proof),
        **required_proof,
    }
    passed = (
        credentials
        and adapter
        and sdk_present
        and required_proof["serial_tool_loop_executed"]
        and required_proof["native_denial_executed"]
        and required_proof["denied_tool_name"]
        and required_proof["side_effects_checked"]
        and _evidence_false(proof, "side_effects_observed")
        and required_proof["parallel_tool_calls"]
        and _evidence_false(proof, "response_format_on_tool_turn")
        and required_proof["runtime_identity_verified"]
        and required_proof["model_name"]
        and required_proof["provider_base_url"]
    )
    return _gate(
        "trueforge_cerebras",
        True,
        "pass" if passed else "fail",
        "Serial TrueForge/Cerebras execution and denied native approval were verified with zero side effects."
        if passed
        else (
            "The serial TrueForge/Cerebras tool loop and denied native approval were not "
            "proved in this environment."
        ),
        evidence,
    )


def _probe_daytona() -> dict[str, Any]:
    credentials = _env_present(("DAYTONA_API_KEY",))
    sdk_present = _daytona_sdk_usable()
    proof = _read_probe_evidence("PEEL_DAYTONA_EVIDENCE_FILE", "daytona")
    required_proof = {
        "sandbox_created": _evidence_bool(proof, "sandbox_created"),
        "attachment_uploaded": _evidence_bool(proof, "attachment_uploaded"),
        "declared_command_executed": _evidence_bool(proof, "declared_command_executed"),
        "artifact_hash_verified": _evidence_bool(proof, "artifact_hash_verified"),
        "sandbox_destroyed": _evidence_bool(proof, "sandbox_destroyed"),
    }
    evidence = {
        "daytona_sdk_present": sdk_present,
        "credentials_present": credentials,
        "evidence_file_present": bool(proof),
        **required_proof,
    }
    passed = credentials and sdk_present and all(required_proof.values())
    return _gate(
        "daytona",
        True,
        "pass" if passed else "fail",
        "Fresh Daytona execution and artifact custody were verified."
        if passed
        else "Fresh Daytona execution and artifact custody were not proved in this environment.",
        evidence,
    )


def _probe_owned_mail() -> dict[str, Any]:
    imap_configured = _env_present(("IMAP_HOST", "IMAP_USERNAME", "IMAP_PASSWORD"))
    smtp_configured = _env_present(("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"))
    proof = _read_probe_evidence("PEEL_MAIL_EVIDENCE_FILE", "owned_mail")
    required_proof = {
        "draft_retrieval_executed": _evidence_bool(proof, "draft_retrieval_executed"),
        "draft_envelope_valid": _evidence_bool(proof, "draft_envelope_valid"),
        "owned_recipient_delivery_executed": _evidence_bool(proof, "owned_recipient_delivery_executed"),
    }
    evidence = {
        "imap_configuration_present": imap_configured,
        "smtp_configuration_present": smtp_configured,
        "evidence_file_present": bool(proof),
        **required_proof,
    }
    passed = (
        imap_configured
        and smtp_configured
        and required_proof["draft_retrieval_executed"]
        and required_proof["draft_envelope_valid"]
        and required_proof["owned_recipient_delivery_executed"]
    )
    return _gate(
        "owned_mail",
        True,
        "pass" if passed else "fail",
        "Owned Gmail draft retrieval and owned-recipient SMTP delivery were verified."
        if passed
        else "Owned Gmail draft retrieval and SMTP delivery were not proved in this environment.",
        evidence,
    )


def _probe_reveal() -> dict[str, Any]:
    return _gate(
        "reveal",
        False,
        "cut",
        "Sensitive Reveal values are cut until private transport and retention are independently proved.",
        {
            "private_path_proven": False,
            "recovered_values_read": False,
            "recovered_values_recorded": False,
            "metadata_only_policy": True,
        },
    )


def _probe_libreoffice() -> dict[str, Any]:
    path = shutil.which("libreoffice") or shutil.which("soffice")
    evidence = {"binary_present": path is not None, "version_probe_succeeded": False}
    if path is not None:
        succeeded = _run([path, "--version"])
        evidence["version_probe_succeeded"] = succeeded
    if evidence["version_probe_succeeded"]:
        return _gate(
            "libreoffice",
            False,
            "pass",
            "LibreOffice is available for the supported-profile reopen check.",
            evidence,
        )
    return _gate(
        "libreoffice",
        False,
        "cut",
        "LibreOffice is unavailable; the LibreOffice-dependent verification route is cut.",
        evidence,
    )


def _probe_pivot_fixture(root: Path) -> dict[str, Any]:
    fixture_root = root / "fixtures"
    candidates = sorted(fixture_root.rglob("*.xlsx")) if fixture_root.exists() else []
    evidence: dict[str, Any] = {
        "fixture_directory_present": fixture_root.exists(),
        "candidate_count": len(candidates),
        "trusted_fixture_found": False,
        "required_parts_found": False,
    }
    for candidate in candidates:
        try:
            with zipfile.ZipFile(candidate) as package:
                members = {member.lower() for member in package.namelist()}
                has_definition = any("pivotcachedefinition" in member for member in members)
                has_records = any("pivotcacherecords" in member for member in members)
                shared_items = any(
                    b"<sharedItems" in package.read(member)
                    for member in package.namelist()
                    if member.lower().endswith(".xml")
                )
        except (OSError, ValueError, zipfile.BadZipFile):
            continue
        if has_definition and has_records and shared_items:
            evidence["trusted_fixture_found"] = True
            evidence["required_parts_found"] = True
            break

    if evidence["required_parts_found"]:
        return _gate(
            "pivot_fixture",
            False,
            "pass",
            "A pivot fixture contains the required cache definition, records, and shared items.",
            evidence,
        )
    return _gate(
        "pivot_fixture",
        False,
        "cut",
        "No trusted pivot fixture was inspected; pivot coverage is an explicit scope cut.",
        evidence,
    )


def _probe_host() -> dict[str, Any]:
    modules = {
        name: _module_present(name)
        for name in ("pytest", "openpyxl", "xlsxwriter", "uno", "cerebras.cloud.sdk")
    }
    commands = {
        name: _command_path(name) is not None
        for name in ("node", "npm", "bun", "daytona", "libreoffice")
    }
    return _gate(
        "host_baseline",
        False,
        "pass",
        "Host facts were captured without reading secret values or workbook content.",
        {
            "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "modules_present": modules,
            "commands_present": commands,
        },
    )


def build_report(
    root: Path, repo: str, offline: bool, pull_request_number: int | None = None
) -> dict[str, Any]:
    expected_commit = _git_head(root)
    gates = [
        _probe_github_qodo(repo, offline, pull_request_number, expected_commit),
        _probe_trueforge_cerebras(),
        _probe_daytona(),
        _probe_owned_mail(),
        _probe_reveal(),
        _probe_libreoffice(),
        _probe_pivot_fixture(root),
        _probe_host(),
    ]
    mandatory_failures = [
        gate["name"]
        for gate in gates
        if gate["mandatory"] and gate["status"] != "pass"
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_on": dt.date.today().isoformat(),
        "repo": repo,
        "mode": "offline" if offline else "live",
        "decision": "GO" if not mandatory_failures else "NO-GO",
        "mandatory_failures": mandatory_failures,
        "gates": gates,
    }


def _markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Peel environment gate",
        "",
        f"- Generated: `{report['generated_on']}`",
        f"- Repository: `{report['repo']}`",
        f"- Mode: `{report['mode']}`",
        f"- **Decision:** `{report['decision']}`",
        "",
        "| Gate | Required | Status |",
        "| --- | --- | --- |",
    ]
    for gate in report["gates"]:
        required = "yes" if gate["mandatory"] else "no"
        lines.append(f"| `{gate['name']}` | {required} | `{gate['status']}` |")
    lines.extend(["", "## Evidence", ""])
    for gate in report["gates"]:
        lines.append(f"### `{gate['name']}` — `{gate['status']}`")
        lines.append("")
        lines.append(f"{gate['summary']}")
        lines.append("")
        lines.append("```json")
        lines.append(json.dumps(gate["evidence"], indent=2, sort_keys=True))
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=REPO_DEFAULT)
    parser.add_argument(
        "--pull-request",
        type=int,
        default=None,
        help="target pull request number for exact current-commit Qodo verification",
    )
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    parser.add_argument(
        "--offline",
        action="store_true",
        help="skip network-backed GitHub probes and record them as failed",
    )
    args = parser.parse_args(argv)

    _load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    pull_request_number = args.pull_request
    if pull_request_number is None and os.environ.get("PEEL_GITHUB_PR_NUMBER"):
        try:
            pull_request_number = int(os.environ["PEEL_GITHUB_PR_NUMBER"])
        except ValueError:
            pull_request_number = None
    report = build_report(
        Path(__file__).resolve().parents[1], args.repo, args.offline, pull_request_number
    )
    output = json.dumps(report, indent=2, sort_keys=True) if args.format == "json" else _markdown(report)
    print(output)
    return 0 if report["decision"] == "GO" else 2


if __name__ == "__main__":
    raise SystemExit(main())
