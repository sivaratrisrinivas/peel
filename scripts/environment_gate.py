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
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any, Sequence


REPO_DEFAULT = "sivaratrisrinivas/peel"
SCHEMA_VERSION = "1"


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


def _probe_github_qodo(repo: str, offline: bool) -> dict[str, Any]:
    evidence: dict[str, Any] = {
        "repo": repo,
        "offline": offline,
        "gh_available": _command_path("gh") is not None,
        "authenticated": False,
        "public_repo": False,
        "qodo_review_found": False,
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

    authenticated, auth_stdout, auth_stderr = _capture(["gh", "auth", "status"])
    auth_output = f"{auth_stdout}\n{auth_stderr}".lower()
    authenticated = authenticated and not any(
        marker in auth_output
        for marker in ("failed to log in", "invalid", "not logged in", "authentication failed")
    )
    evidence["authenticated"] = authenticated
    if not authenticated:
        return _gate(
            "github_qodo",
            True,
            "fail",
            "GitHub authentication failed; Qodo review was not verified.",
            evidence,
        )

    public_probe, public_value, _ = _capture(["gh", "api", f"repos/{repo}", "--jq", ".private"])
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

    try:
        result = subprocess.run(
            [
                "gh",
                "pr",
                "list",
                "--repo",
                repo,
                "--state",
                "all",
                "--limit",
                "100",
                "--json",
                "number",
                "--jq",
                ".[].number",
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        result = None

    if result is None or result.returncode != 0:
        return _gate(
            "github_qodo",
            True,
            "fail",
            "Pull-request review evidence could not be fetched.",
            evidence,
        )

    for line in result.stdout.splitlines():
        try:
            pull_request = int(line.strip())
        except ValueError:
            continue
        reviewed, review_output, _ = _capture(
            [
                "gh",
                "api",
                f"repos/{repo}/pulls/{pull_request}/reviews",
                "--jq",
                ".[]?.user.login",
            ],
            timeout=15,
        )
        if reviewed:
            # A successful API call alone is not Qodo evidence. The actual
            # reviewer identity is intentionally not emitted, but this probe
            # only passes when the review response contains a Qodo identity.
            if any("qodo" in login.lower() for login in review_output.splitlines()):
                evidence["qodo_review_found"] = True
                break

    status = "pass" if evidence["qodo_review_found"] else "fail"
    summary = (
        "Public repository and Qodo review evidence verified."
        if status == "pass"
        else "Public repository was reachable, but no Qodo review evidence was found."
    )
    return _gate("github_qodo", True, status, summary, evidence)


def _probe_trueforge_cerebras() -> dict[str, Any]:
    credentials = _env_present(("CEREBRAS_API_KEY", "TRUEFORGE_API_KEY"))
    adapter = any(_command_path(command) for command in ("trueforge", "cerebras"))
    sdk_present = importlib.util.find_spec("cerebras.cloud.sdk") is not None
    evidence = {
        "credentials_present": credentials,
        "runtime_adapter_present": adapter,
        "cerebras_sdk_present": sdk_present,
        "serial_tool_loop_executed": False,
        "native_denial_executed": False,
        "side_effects_observed": False,
    }
    return _gate(
        "trueforge_cerebras",
        True,
        "fail",
        "The serial TrueForge/Cerebras tool loop and denied native approval were not proved in this environment.",
        evidence,
    )


def _probe_daytona() -> dict[str, Any]:
    cli_path = _command_path("daytona")
    credentials = _env_present(("DAYTONA_API_KEY",))
    version_probe_succeeded = _run([cli_path, "version"]) if cli_path else False
    evidence = {
        "cli_present": cli_path is not None,
        "version_probe_succeeded": version_probe_succeeded,
        "credentials_present": credentials,
        "sandbox_created": False,
        "attachment_uploaded": False,
        "declared_command_executed": False,
        "artifact_hash_verified": False,
        "sandbox_destroyed": False,
    }
    return _gate(
        "daytona",
        True,
        "fail",
        "Fresh Daytona execution and artifact custody were not proved in this environment.",
        evidence,
    )


def _probe_owned_mail() -> dict[str, Any]:
    imap_configured = _env_present(("IMAP_HOST", "IMAP_USERNAME", "IMAP_PASSWORD"))
    smtp_configured = _env_present(("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"))
    evidence = {
        "imap_configuration_present": imap_configured,
        "smtp_configuration_present": smtp_configured,
        "draft_retrieval_executed": False,
        "owned_recipient_delivery_executed": False,
        "smtp_activity_from_denial": False,
    }
    return _gate(
        "owned_mail",
        True,
        "fail",
        "Owned Gmail draft retrieval and SMTP delivery were not proved in this environment.",
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
        name: importlib.util.find_spec(name) is not None
        for name in ("pytest", "openpyxl", "xlsxwriter", "uno", "cerebras.cloud.sdk")
    }
    commands = {name: _command_path(name) is not None for name in ("node", "npm", "bun", "daytona", "libreoffice")}
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


def build_report(root: Path, repo: str, offline: bool) -> dict[str, Any]:
    gates = [
        _probe_github_qodo(repo, offline),
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
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    parser.add_argument(
        "--offline",
        action="store_true",
        help="skip network-backed GitHub probes and record them as failed",
    )
    args = parser.parse_args(argv)

    report = build_report(Path(__file__).resolve().parents[1], args.repo, args.offline)
    output = json.dumps(report, indent=2, sort_keys=True) if args.format == "json" else _markdown(report)
    print(output)
    return 0 if report["decision"] == "GO" else 2


if __name__ == "__main__":
    raise SystemExit(main())
