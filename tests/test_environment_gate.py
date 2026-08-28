import json
import os
import subprocess
import sys
from collections.abc import Callable
from types import SimpleNamespace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import environment_gate
from scripts import daytona_gate_probe
from scripts import mail_gate_probe


SCRIPT = ROOT / "scripts" / "environment_gate.py"


def run_gate(
    *arguments: str, extra_environment: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
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


def test_missing_dotted_module_is_recorded_as_absent(monkeypatch) -> None:
    original_find_spec = environment_gate.importlib.util.find_spec

    def find_spec(name: str):
        if name == "cerebras.cloud.sdk":
            raise ModuleNotFoundError(name)
        return original_find_spec(name)

    monkeypatch.setattr(environment_gate.importlib.util, "find_spec", find_spec)

    assert environment_gate._module_present("cerebras.cloud.sdk") is False
    host_gate = environment_gate._probe_host()
    assert host_gate["evidence"]["modules_present"]["cerebras.cloud.sdk"] is False


def test_dotenv_loader_accepts_values_without_executing_shell(monkeypatch, tmp_path: Path) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "export IMAP_HOST=imap.gmail.com\n"
        "SMTP_HOST=\"smtp.gmail.com\\r\"\n"
        "ESCAPED_CRLF=value\\r\\n\n"
        "INVALID-NAME=ignored\n",
        encoding="utf-8",
    )

    monkeypatch.delenv("IMAP_HOST", raising=False)
    monkeypatch.delenv("SMTP_HOST", raising=False)
    loaders: tuple[Callable[[Path], None], ...] = (
        environment_gate._load_dotenv,
        daytona_gate_probe._load_dotenv,
        mail_gate_probe._load_dotenv,
    )
    for loader in loaders:
        monkeypatch.delenv("ESCAPED_CRLF", raising=False)
        loader(dotenv)
        assert os.environ["ESCAPED_CRLF"] == "value"

    assert os.environ["IMAP_HOST"] == "imap.gmail.com"
    assert os.environ["SMTP_HOST"] == "smtp.gmail.com"


def test_github_probe_uses_resolved_executable_path(monkeypatch) -> None:
    calls: list[list[str]] = []

    def command_path(name: str) -> str | None:
        return "/opt/tools/gh" if name == "gh" else None

    def capture(command, timeout=8.0):
        calls.append(list(command))
        if command[1:3] == ["api", "user"]:
            return True, "", ""
        if command[1:3] == ["api", "repos/sivaratrisrinivas/peel"]:
            return True, "false\n", ""
        if any("pulls/11" in item for item in command) and not any(
            "reviews" in item for item in command
        ):
            return True, '{"number":11,"state":"open","head_sha":"abc123"}\n', ""
        if any("pulls/11/reviews" in item for item in command):
            return True, '{"login":"qodo-code-review[bot]","state":"COMMENTED","commit_id":"abc123"}\n', ""
        if any("issues/11/comments" in item for item in command):
            return True, json.dumps(
                {
                    "id": 1,
                    "created_at": "2026-08-28T01:00:00Z",
                    "updated_at": "2026-08-28T01:00:00Z",
                    "login": "qodo-code-review[bot]",
                    "body": (
                        "<h3>Code Review by Qodo</h3>"
                        "<summary>  1.  Finding <code>✓ Resolved</code></summary> abc123"
                    ),
                }
            ) + "\n", ""
        raise AssertionError(command)

    def run(command, **kwargs):
        calls.append(list(command))
        return SimpleNamespace(returncode=0, stdout="1\n", stderr="")

    monkeypatch.setattr(environment_gate, "_command_path", command_path)
    monkeypatch.setattr(environment_gate, "_capture", capture)
    monkeypatch.setattr(environment_gate.subprocess, "run", run)

    gate = environment_gate._probe_github_qodo(
        "sivaratrisrinivas/peel", offline=False, pull_request_number=11, expected_commit="abc123"
    )

    assert gate["status"] == "pass"
    assert calls
    assert all(command[0] == "/opt/tools/gh" for command in calls)


def test_qodo_findings_must_be_resolved_for_target_commit() -> None:
    resolved = [
        {
            "id": 1,
            "created_at": "2026-08-28T01:00:00Z",
            "updated_at": "2026-08-28T01:00:00Z",
            "login": "qodo-code-review[bot]",
            "body": (
                "<h3>Code Review by Qodo</h3>"
                "<summary>  1.  Finding <code>✓ Resolved</code></summary> abc123"
            ),
        }
    ]
    unresolved = [
        {
            "id": 2,
            "created_at": "2026-08-28T02:00:00Z",
            "updated_at": "2026-08-28T02:00:00Z",
            "login": "qodo-code-review[bot]",
            "body": (
                "<h3>Code Review by Qodo</h3>"
                "<summary>  1.  Finding <code>🐞 Bug</code></summary> abc123"
            ),
        }
    ]
    clean = [
        {
            "id": 3,
            "created_at": "2026-08-28T03:00:00Z",
            "updated_at": "2026-08-28T03:00:00Z",
            "login": "qodo-code-review[bot]",
            "body": "<h3>Code Review by Qodo</h3> abc123",
        }
    ]

    assert environment_gate._qodo_findings_resolved(resolved, "abc123") is True
    assert environment_gate._qodo_findings_resolved(unresolved, "abc123") is False
    assert environment_gate._qodo_findings_resolved(resolved, "other-commit") is False
    assert environment_gate._qodo_findings_resolved(resolved + unresolved, "abc123") is False
    assert environment_gate._qodo_findings_resolved(clean, "abc123") is True
    assert environment_gate._qodo_findings_resolved(unresolved + clean, "abc123") is True


def test_live_proof_records_can_clear_integration_gates(monkeypatch, tmp_path: Path) -> None:
    trueforge_file = tmp_path / "trueforge.json"
    trueforge_file.write_text(
        json.dumps(
            {
                "schema_version": "1",
                "probe": "trueforge_cerebras",
                "model_name": "gpt-oss-120b",
                "provider_base_url": "https://api.cerebras.ai/v1",
                "parallel_tool_calls": False,
                "response_format_on_tool_turn": False,
                "runtime_identity_verified": True,
                "serial_tool_loop_executed": True,
                "native_denial_executed": True,
                "denied_tool_name": "send_email",
                "side_effects_checked": True,
                "side_effects_observed": False,
            }
        ),
        encoding="utf-8",
    )
    daytona_file = tmp_path / "daytona.json"
    daytona_file.write_text(
        json.dumps(
            {
                "schema_version": "1",
                "probe": "daytona",
                "sandbox_created": True,
                "attachment_uploaded": True,
                "declared_command_executed": True,
                "artifact_hash_verified": True,
                "sandbox_destroyed": True,
            }
        ),
        encoding="utf-8",
    )
    mail_file = tmp_path / "mail.json"
    mail_file.write_text(
        json.dumps(
            {
                "schema_version": "1",
                "probe": "owned_mail",
                "draft_retrieval_executed": True,
                "draft_envelope_valid": True,
                "owned_recipient_delivery_executed": True,
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setenv("PEEL_TRUEFORGE_EVIDENCE_FILE", str(trueforge_file))
    monkeypatch.setenv("PEEL_DAYTONA_EVIDENCE_FILE", str(daytona_file))
    monkeypatch.setenv("PEEL_MAIL_EVIDENCE_FILE", str(mail_file))
    monkeypatch.setattr(environment_gate, "_env_present", lambda names: True)
    monkeypatch.setattr(
        environment_gate,
        "_command_path",
        lambda name: None if name == "daytona" else f"/bin/{name}",
    )
    monkeypatch.setattr(environment_gate, "_module_present", lambda name: True)
    monkeypatch.setattr(environment_gate, "_daytona_sdk_usable", lambda: True)
    monkeypatch.setattr(environment_gate, "_run", lambda command, timeout=8.0: True)

    assert environment_gate._probe_trueforge_cerebras()["status"] == "pass"
    proof = json.loads(trueforge_file.read_text(encoding="utf-8"))
    proof["model_name"] = "gemma-4-31b"
    trueforge_file.write_text(json.dumps(proof), encoding="utf-8")
    assert environment_gate._probe_trueforge_cerebras()["status"] == "pass"
    assert environment_gate._probe_daytona()["status"] == "pass"
    assert environment_gate._probe_owned_mail()["status"] == "pass"


def test_probe_evidence_requires_matching_probe_name(tmp_path: Path, monkeypatch) -> None:
    record = tmp_path / "wrong-probe.json"
    record.write_text(json.dumps({"schema_version": "1", "probe": "daytona"}), encoding="utf-8")
    monkeypatch.setenv("PEEL_TRUEFORGE_EVIDENCE_FILE", str(record))

    assert environment_gate._read_probe_evidence(
        "PEEL_TRUEFORGE_EVIDENCE_FILE", "trueforge_cerebras"
    ) == {}


def test_mail_probe_accepts_only_the_required_draft_envelope(monkeypatch) -> None:
    monkeypatch.setenv("PEEL_OWNED_RECIPIENT", "owned@example.com")
    message = mail_gate_probe.EmailMessage()
    message["Subject"] = "Disclosure draft"
    message["To"] = "owned@example.com"
    message.set_content("Intended disclosure: the recipient may receive this workbook.")
    message.add_attachment(
        b"xlsx bytes",
        maintype="application",
        subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="disclosure.xlsx",
    )

    assert mail_gate_probe._draft_envelope_valid(message) is True

    nested_attachment = mail_gate_probe.EmailMessage()
    nested_attachment.set_content("nested attachment")
    nested_attachment.make_mixed()
    nested_attachment.add_attachment(
        b"nested bytes", maintype="application", subtype="octet-stream"
    )
    nested_attachment["Content-Disposition"] = 'attachment; filename="nested.bin"'
    message.attach(nested_attachment)
    assert mail_gate_probe._draft_envelope_valid(message) is False

    message.add_attachment(b"second", maintype="application", subtype="pdf", filename="other.pdf")
    assert mail_gate_probe._draft_envelope_valid(message) is False

    message = mail_gate_probe.EmailMessage()
    message["Subject"] = "Disclosure draft"
    message["To"] = "owned@example.com"
    message.set_content("Intended disclosure: first\nIntended disclosure: second")
    message.add_attachment(
        b"xlsx bytes",
        maintype="application",
        subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="disclosure.xlsx",
    )
    assert mail_gate_probe._draft_envelope_valid(message) is False

    other_recipient = mail_gate_probe.EmailMessage()
    other_recipient["Subject"] = "Disclosure draft"
    other_recipient["To"] = "other@example.com"
    other_recipient.set_content("Intended disclosure: the recipient may receive this workbook.")
    other_recipient.add_attachment(
        b"xlsx bytes",
        maintype="application",
        subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="disclosure.xlsx",
    )
    assert mail_gate_probe._draft_envelope_valid(other_recipient) is False


def test_mail_probe_normalizes_gmail_app_password_grouping(monkeypatch) -> None:
    monkeypatch.setenv("SMTP_PASSWORD", "abcd efgh ijkl mnop")

    assert mail_gate_probe._secret("SMTP_PASSWORD") == "abcdefghijklmnop"


def test_missing_live_proof_keeps_integration_gates_failed(monkeypatch) -> None:
    monkeypatch.delenv("PEEL_TRUEFORGE_EVIDENCE_FILE", raising=False)
    monkeypatch.delenv("PEEL_DAYTONA_EVIDENCE_FILE", raising=False)
    monkeypatch.delenv("PEEL_MAIL_EVIDENCE_FILE", raising=False)
    monkeypatch.setattr(environment_gate, "_env_present", lambda names: True)
    monkeypatch.setattr(environment_gate, "_command_path", lambda name: f"/bin/{name}")
    monkeypatch.setattr(environment_gate, "_module_present", lambda name: True)
    monkeypatch.setattr(environment_gate, "_run", lambda command, timeout=8.0: True)

    assert environment_gate._probe_trueforge_cerebras()["status"] == "fail"
    assert environment_gate._probe_daytona()["status"] == "fail"
    assert environment_gate._probe_owned_mail()["status"] == "fail"
