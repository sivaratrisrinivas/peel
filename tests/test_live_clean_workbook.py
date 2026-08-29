from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import zipfile
from email.message import EmailMessage
from pathlib import Path

from scripts import daytona_engine
from scripts import mail_gate_probe


ROOT = Path(__file__).resolve().parents[1]


def _workbook(path: Path, workbook_xml: str = '<workbook><sheets><sheet name="Visible" sheetId="1"/></sheets></workbook>') -> bytes:
    with zipfile.ZipFile(path, "w") as package:
        package.writestr(
            "[Content_Types].xml",
            '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        )
        package.writestr("xl/workbook.xml", workbook_xml)
        package.writestr("xl/worksheets/sheet1.xml", "<worksheet><sheetData/></worksheet>")
    return path.read_bytes()


def test_production_engine_contract_reports_clean_and_verified_without_rewriting(tmp_path: Path) -> None:
    source = tmp_path / "clean.xlsx"
    payload = _workbook(source)
    digest = hashlib.sha256(payload).hexdigest()

    scan = daytona_engine._scan_package(source, digest)
    assert scan == {
        "version": "1",
        "operation": "scan",
        "status": "clean",
        "artifact_sha256": digest,
        "engine_version": "1.0.0",
        "supported_profile": "accepted",
        "findings": [],
    }

    verified = daytona_engine._verify_package(source, digest, digest)
    assert verified["status"] == "verified"
    assert verified["artifact_unchanged"] is True
    assert Path(daytona_engine.OUTPUT_PATH).read_bytes() == payload


def test_production_engine_contract_reports_all_hidden_worksheet_findings(tmp_path: Path) -> None:
    source = tmp_path / "hidden.xlsx"
    payload = _workbook(
        source,
        '<workbook><sheets><sheet name="One" state="hidden"/><sheet name="Two" state="veryHidden"/></sheets></workbook>',
    )
    result = daytona_engine._scan_package(source, hashlib.sha256(payload).hexdigest())

    assert result["status"] == "findings"
    assert result["findings"] == [
        {"mechanism": "hidden_worksheet", "location": "xl/workbook.xml", "count": 2}
    ]


def test_live_engine_cli_rejects_a_hash_mismatch_without_local_fallback(tmp_path: Path) -> None:
    source = tmp_path / "clean.xlsx"
    _workbook(source)
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "daytona_engine.py"),
            "--operation",
            "scan",
            "--input",
            str(source),
            "--artifact-sha256",
            "0" * 64,
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    assert json.loads(result.stdout)["refusal_code"] == "integrity_failure"


def test_live_mail_parser_returns_a_bounded_draft_envelope(monkeypatch) -> None:
    monkeypatch.setenv("PEEL_OWNED_RECIPIENT", "owned@example.com")
    message = EmailMessage()
    message["From"] = "sender@example.com"
    message["To"] = "owned@example.com"
    message["Subject"] = "Clean workbook"
    message.set_content("Intended disclosure: visible workbook only.")
    message.add_attachment(b"xlsx", maintype="application", subtype="octet-stream", filename="clean.xlsx")

    draft = mail_gate_probe._parse_eligible_draft(
        message,
        mailbox_account="sender@example.com",
        folder_uidvalidity="uidvalidity-1",
        message_uid="9",
    )

    assert draft is not None
    assert draft.sender == "sender@example.com"
    assert draft.recipient == "owned@example.com"
    assert draft.attachment_bytes == b"xlsx"
    assert draft.folder_uidvalidity == "uidvalidity-1"


def test_mail_retrieval_bounds_a_single_scan_batch(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("IMAP_HOST", "imap.example.com")
    monkeypatch.setenv("IMAP_USERNAME", "sender@example.com")
    monkeypatch.setenv("IMAP_PASSWORD", "password")
    monkeypatch.setenv("PEEL_OWNED_RECIPIENT", "owned@example.com")
    eligible = EmailMessage()
    eligible["From"] = "sender@example.com"
    eligible["To"] = "owned@example.com"
    eligible["Subject"] = "Old eligible workbook"
    eligible.set_content("Intended disclosure: visible workbook only.")
    eligible.add_attachment(b"xlsx", maintype="application", subtype="octet-stream", filename="old.xlsx")

    ineligible = EmailMessage()
    ineligible["From"] = "sender@example.com"
    ineligible["To"] = "owned@example.com"
    ineligible["Subject"] = "Half-authored draft"
    ineligible.set_content("Still writing.")

    class FakeImap:
        fetch_count = 0

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def login(self, _username, _password):
            return "OK", []

        def select(self, _mailbox, readonly=True):
            assert readonly is True
            return "OK", []

        def response(self, name):
            assert name == "UIDVALIDITY"
            return "OK", [b"uidvalidity-1"]

        def uid(self, operation, message_id, _query=None):
            if operation == "search":
                return "OK", [b" ".join(str(uid).encode() for uid in range(1, 102))]
            assert operation == "fetch"
            self.fetch_count += 1
            raw = eligible.as_bytes() if message_id == "1" else ineligible.as_bytes()
            return "OK", [(b"RFC822", raw)]

    fake = FakeImap()
    monkeypatch.setattr(mail_gate_probe.imaplib, "IMAP4_SSL", lambda *_args, **_kwargs: fake)

    draft = mail_gate_probe._retrieve_eligible_draft(cursor_path=tmp_path / "mailbox-cursor.json")

    assert draft is None
    assert fake.fetch_count == 50


def test_mail_retrieval_batches_uids_and_wraps_with_a_persistent_cursor(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("IMAP_HOST", "imap.example.com")
    monkeypatch.setenv("IMAP_USERNAME", "sender@example.com")
    monkeypatch.setenv("IMAP_PASSWORD", "password")
    monkeypatch.setenv("PEEL_OWNED_RECIPIENT", "owned@example.com")
    eligible = EmailMessage()
    eligible["From"] = "sender@example.com"
    eligible["To"] = "owned@example.com"
    eligible["Subject"] = "Old eligible workbook"
    eligible.set_content("Intended disclosure: visible workbook only.")
    eligible.add_attachment(b"xlsx", maintype="application", subtype="octet-stream", filename="old.xlsx")

    ineligible = EmailMessage()
    ineligible["From"] = "sender@example.com"
    ineligible["To"] = "owned@example.com"
    ineligible["Subject"] = "Half-authored draft"
    ineligible.set_content("Still writing.")

    class FakeImap:
        fetch_counts: list[int] = []

        def __enter__(self):
            self.fetch_counts.append(0)
            return self

        def __exit__(self, *_args):
            return None

        def login(self, _username, _password):
            return "OK", []

        def select(self, _mailbox, readonly=True):
            assert readonly is True
            return "OK", []

        def response(self, name):
            assert name == "UIDVALIDITY"
            return "OK", [b"uidvalidity-1"]

        def uid(self, operation, message_id, query=None):
            if operation == "search":
                return "OK", [b"1 2 3 4 5"]
            assert operation == "fetch"
            self.fetch_counts[-1] += 1
            raw = eligible.as_bytes() if message_id == "1" else ineligible.as_bytes()
            return "OK", [(b"RFC822", raw)]

    fake = FakeImap()
    monkeypatch.setattr(mail_gate_probe.imaplib, "IMAP4_SSL", lambda *_args, **_kwargs: fake)
    cursor = tmp_path / "mailbox-cursor.json"

    assert mail_gate_probe._retrieve_eligible_draft(max_messages=2, cursor_path=cursor) is None
    assert mail_gate_probe._retrieve_eligible_draft(max_messages=2, cursor_path=cursor) is None
    found = mail_gate_probe._retrieve_eligible_draft(max_messages=2, cursor_path=cursor)

    assert found is not None
    assert found.message_uid == "1"
    assert fake.fetch_counts == [4, 4, 2]
    assert json.loads(cursor.read_text(encoding="utf-8"))["folder_uidvalidity"] == "uidvalidity-1"


def test_mail_retrieval_does_not_reuse_cursor_across_mailbox_accounts(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("IMAP_HOST", "imap.example.com")
    monkeypatch.setenv("IMAP_PORT", "993")
    monkeypatch.setenv("IMAP_USERNAME", "account-a@example.com")
    monkeypatch.setenv("IMAP_PASSWORD", "password")
    monkeypatch.setenv("PEEL_OWNED_RECIPIENT", "owned@example.com")
    eligible = EmailMessage()
    eligible["From"] = "sender@example.com"
    eligible["To"] = "owned@example.com"
    eligible["Subject"] = "Account B workbook"
    eligible.set_content("Intended disclosure: visible workbook only.")
    eligible.add_attachment(b"xlsx", maintype="application", subtype="octet-stream", filename="account-b.xlsx")

    ineligible = EmailMessage()
    ineligible["From"] = "sender@example.com"
    ineligible["To"] = "owned@example.com"
    ineligible["Subject"] = "Half-authored draft"
    ineligible.set_content("Still writing.")

    class FakeImap:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def login(self, _username, _password):
            return "OK", []

        def select(self, _mailbox, readonly=True):
            assert readonly is True
            return "OK", []

        def response(self, name):
            assert name == "UIDVALIDITY"
            return "OK", [b"uidvalidity-1"]

        def uid(self, operation, message_id, _query=None):
            if operation == "search":
                return "OK", [b"1 2 3"]
            assert operation == "fetch"
            raw = eligible.as_bytes() if os.environ["IMAP_USERNAME"].startswith("account-b") and message_id == "3" else ineligible.as_bytes()
            return "OK", [(b"RFC822", raw)]

    fake = FakeImap()
    monkeypatch.setattr(mail_gate_probe.imaplib, "IMAP4_SSL", lambda *_args, **_kwargs: fake)
    cursor = tmp_path / "mailbox-cursor.json"

    assert mail_gate_probe._retrieve_eligible_draft(max_messages=1, cursor_path=cursor) is None
    monkeypatch.setenv("IMAP_USERNAME", "account-b@example.com")
    found = mail_gate_probe._retrieve_eligible_draft(max_messages=1, cursor_path=cursor)

    assert found is not None
    assert found.message_uid == "3"


def test_mail_retrieval_configures_an_imap_socket_timeout(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeImap:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def __init__(self, *_args, **kwargs):
            captured.update(kwargs)

        def login(self, _username, _password):
            return "OK", []

        def select(self, _mailbox, readonly=True):
            return "OK", []

        def response(self, name):
            assert name == "UIDVALIDITY"
            return "OK", [b"uidvalidity-1"]

        def uid(self, operation, _message_id):
            assert operation == "search"
            return "OK", [b""]

    monkeypatch.setenv("IMAP_HOST", "imap.example.com")
    monkeypatch.setenv("IMAP_USERNAME", "sender@example.com")
    monkeypatch.setenv("IMAP_PASSWORD", "password")
    monkeypatch.setattr(mail_gate_probe.imaplib, "IMAP4_SSL", FakeImap)

    assert mail_gate_probe._retrieve_eligible_draft() is None
    assert captured["timeout"] == 20.0


def test_live_runner_is_invocable_as_a_script_and_fails_closed_without_configuration(
    tmp_path: Path, monkeypatch
) -> None:
    for name in (
        "PEEL_OWNED_RECIPIENT",
        "IMAP_HOST",
        "IMAP_USERNAME",
        "IMAP_PASSWORD",
        "DAYTONA_API_KEY",
        "SMTP_HOST",
        "SMTP_USERNAME",
        "SMTP_PASSWORD",
    ):
        monkeypatch.delenv(name, raising=False)
    evidence = tmp_path / "evidence.json"
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "live_clean_workbook.py"),
            "--repo-root",
            str(tmp_path),
            "--evidence-file",
            str(evidence),
        ],
        cwd=ROOT,
        env={"PATH": os.environ.get("PATH", "")},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 2
    assert json.loads(result.stdout)["failure_code"] == "live_configuration_missing"
    assert json.loads(evidence.read_text(encoding="utf-8"))["status"] == "failed"
