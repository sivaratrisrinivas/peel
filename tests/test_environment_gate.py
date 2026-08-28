import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "environment_gate.py"


def run_gate(*arguments: str, extra_environment: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.update(extra_environment or {})
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--offline", "--format", "json", *arguments],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def test_offline_gate_reports_mandatory_no_go_and_optional_cuts() -> None:
    result = run_gate()

    assert result.returncode == 2
    report = json.loads(result.stdout)

    assert report["decision"] == "NO-GO"
    assert report["schema_version"] == "1"
    assert {gate["status"] for gate in report["gates"]} <= {"pass", "fail", "cut"}

    mandatory_failures = {
        gate["name"]
        for gate in report["gates"]
        if gate["mandatory"] and gate["status"] == "fail"
    }
    assert {
        "github_qodo",
        "trueforge_cerebras",
        "daytona",
        "owned_mail",
    } <= mandatory_failures

    optional_cuts = {
        gate["name"]
        for gate in report["gates"]
        if not gate["mandatory"] and gate["status"] == "cut"
    }
    assert {"reveal", "libreoffice", "pivot_fixture"} <= optional_cuts


def test_report_never_echoes_secret_values() -> None:
    secret = "do-not-record-this-cerebras-key"
    result = run_gate(
        extra_environment={
            "CEREBRAS_API_KEY": secret,
            "TRUEFORGE_API_KEY": "do-not-record-this-trueforge-key",
            "SMTP_PASSWORD": "do-not-record-this-mail-password",
        }
    )

    assert result.returncode == 2
    assert secret not in result.stdout
    assert "do-not-record-this-trueforge-key" not in result.stdout
    assert "do-not-record-this-mail-password" not in result.stdout

    report = json.loads(result.stdout)
    trueforge_gate = next(gate for gate in report["gates"] if gate["name"] == "trueforge_cerebras")
    assert trueforge_gate["evidence"]["credentials_present"] is True


def test_markdown_output_contains_decision_and_gate_table() -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--offline", "--format", "markdown"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 2
    assert "# Peel environment gate" in result.stdout
    assert "**Decision:** `NO-GO`" in result.stdout
    assert "| Gate | Required | Status |" in result.stdout
