#!/usr/bin/env python3
"""Exercise the owned-mail environment gate without recording mail contents."""

from __future__ import annotations

import argparse
import datetime as dt
import imaplib
import json
import os
import re
import smtplib
import ssl
import uuid
from dataclasses import dataclass
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import getaddresses
from pathlib import Path
from typing import Any, cast


SCHEMA_VERSION = "1"
DEFAULT_EVIDENCE_FILE = "/tmp/peel-mail-evidence.json"
MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
REQUIRED_KEYS = (
    "IMAP_HOST",
    "IMAP_USERNAME",
    "IMAP_PASSWORD",
    "SMTP_HOST",
    "SMTP_USERNAME",
    "SMTP_PASSWORD",
)


def _load_dotenv(path: Path = Path(".env")) -> None:
    """Load simple KEY=VALUE entries without executing the file as shell code."""

    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
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


def _secret(name: str) -> str:
    """Read a secret, tolerating Gmail's display grouping spaces in app passwords."""

    value = os.environ.get(name, "")
    return re.sub(r"\s+", "", value) if name.endswith("PASSWORD") else value


def _write_evidence(path: Path, evidence: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


@dataclass(frozen=True)
class RetrievedDraft:
    """The bounded data needed to create one Peel Mailbox Trigger."""

    mailbox_account: str
    folder_uidvalidity: str
    message_uid: str
    sender: str
    recipient: str
    subject: str
    body: str
    attachment_filename: str
    attachment_bytes: bytes


def _body_text(message: EmailMessage) -> str:
    body_parts: list[str] = []
    for part in message.walk():
        if part.get_content_type() != "text/plain" or part.get_content_disposition() == "attachment":
            continue
        try:
            content = part.get_content()
        except (LookupError, UnicodeError):
            continue
        body_parts.append(str(content))
    return "\n".join(body_parts)


def _parse_eligible_draft(
    message: EmailMessage,
    *,
    allowed_recipient: str | None = None,
    mailbox_account: str = "",
    folder_uidvalidity: str = "",
    message_uid: str = "",
) -> RetrievedDraft | None:
    subject = str(message.get("Subject", "")).strip()
    configured_recipient = os.environ.get("PEEL_OWNED_RECIPIENT") or ""
    allowed = (allowed_recipient or configured_recipient).strip().casefold()
    recipients = getaddresses(
        [str(value) for header in ("To", "Cc", "Bcc") for value in message.get_all(header, [])]
    )
    recipient_valid = bool(allowed) and len(recipients) == 1 and recipients[0][1].strip().casefold() == allowed
    senders = getaddresses([str(value) for value in message.get_all("From", [])])
    sender = senders[0][1].strip() if len(senders) == 1 else ""
    attachment_parts: list[tuple[str, bytes]] = []
    for part in message.walk():
        filename = part.get_filename() or ""
        if part.get_content_disposition() == "attachment" or filename:
            payload = part.get_payload(decode=True)
            if isinstance(payload, bytes):
                attachment_parts.append((filename, payload))
            else:
                attachment_parts.append((filename, b""))
    body = _body_text(message)
    disclosure_fields = re.findall(r"(?im)^\s*intended disclosure\s*:\s*(.*?)\s*$", body)
    disclosure_valid = len(disclosure_fields) == 1 and bool(disclosure_fields[0].strip())
    attachment_valid = len(attachment_parts) == 1 and attachment_parts[0][0].lower().endswith(".xlsx")
    if not (
        attachment_valid
        and bool(subject)
        and bool(sender)
        and recipient_valid
        and disclosure_valid
        and "/" not in attachment_parts[0][0]
        and "\\" not in attachment_parts[0][0]
        and 0 < len(attachment_parts[0][1]) <= MAX_ARTIFACT_BYTES
    ):
        return None
    return RetrievedDraft(
        mailbox_account=mailbox_account,
        folder_uidvalidity=folder_uidvalidity,
        message_uid=message_uid,
        sender=sender,
        recipient=recipients[0][1].strip(),
        subject=subject,
        body=body,
        attachment_filename=attachment_parts[0][0],
        attachment_bytes=attachment_parts[0][1],
    )


def _draft_envelope_valid(message: EmailMessage, allowed_recipient: str | None = None) -> bool:
    return _parse_eligible_draft(message, allowed_recipient=allowed_recipient) is not None


def _uidvalidity(client: imaplib.IMAP4_SSL) -> str:
    response = client.response("UIDVALIDITY")
    if response and len(response) == 2 and response[1]:
        value = response[1][0]
        if isinstance(value, bytes):
            return value.decode("ascii", errors="replace")
        return str(value)
    raise RuntimeError("IMAP did not return UIDVALIDITY")


def _retrieve_eligible_draft() -> RetrievedDraft | None:
    host = os.environ["IMAP_HOST"]
    username = os.environ["IMAP_USERNAME"]
    password = _secret("IMAP_PASSWORD")
    mailbox = os.environ.get("IMAP_DRAFTS_MAILBOX", "[Gmail]/Drafts")
    with imaplib.IMAP4_SSL(
        host,
        int(os.environ.get("IMAP_PORT", "993")),
        timeout=float(os.environ.get("IMAP_TIMEOUT_SECONDS", "20")),
    ) as client:
        login_status, _ = client.login(username, password)
        if login_status != "OK":
            return None
        select_status, _ = client.select(mailbox, readonly=True)
        if select_status != "OK":
            return None
        folder_uidvalidity = _uidvalidity(client)
        search_status, data = client.uid("search", "ALL")
        if search_status != "OK" or not data or not data[0]:
            return None
        message_ids = data[0].split()
        # Drafts are a small, bounded mailbox in the supported deployment, but
        # eligibility must not depend on a recency window: an older eligible
        # draft may sit behind newer half-authored drafts.
        for message_id in reversed(message_ids):
            fetch_status, fetched = client.uid("fetch", message_id, "(RFC822)")
            if fetch_status != "OK":
                continue
            raw = b"".join(item[1] for item in fetched if isinstance(item, tuple) and len(item) == 2)
            if not raw:
                continue
            message = cast(EmailMessage, BytesParser(policy=policy.default).parsebytes(raw))
            parsed = _parse_eligible_draft(
                message,
                mailbox_account=username,
                folder_uidvalidity=folder_uidvalidity,
                message_uid=message_id.decode("ascii", errors="replace"),
            )
            if parsed is not None:
                return parsed
        return None


def _retrieve_draft() -> tuple[bool, bool]:
    try:
        return True, _retrieve_eligible_draft() is not None
    except (KeyError, OSError, ValueError, imaplib.IMAP4.error):
        return False, False


def _send_owned_test() -> bool:
    sender = os.environ["SMTP_USERNAME"]
    recipient = os.environ.get("PEEL_OWNED_RECIPIENT", "").strip()
    if not recipient:
        return False
    message = EmailMessage()
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = f"Peel environment gate {uuid.uuid4().hex}"
    message.set_content("Peel environment-gate SMTP delivery test.")
    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(
        os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", "465")), context=context, timeout=20
    ) as client:
        client.login(sender, _secret("SMTP_PASSWORD"))
        refused = client.send_message(message)
    return not refused


def main() -> int:
    _load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-file", default=os.environ.get("PEEL_MAIL_EVIDENCE_FILE", DEFAULT_EVIDENCE_FILE))
    parser.add_argument(
        "--send",
        action="store_true",
        help="send one uniquely identified test message to PEEL_OWNED_RECIPIENT",
    )
    args = parser.parse_args()
    imap_configured = all(bool(os.environ.get(name)) for name in REQUIRED_KEYS[:3])
    smtp_configured = all(bool(os.environ.get(name)) for name in REQUIRED_KEYS[3:])
    evidence: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "probe": "owned_mail",
        "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "imap_configuration_present": imap_configured,
        "smtp_configuration_present": smtp_configured,
        "draft_retrieval_executed": False,
        "draft_envelope_valid": False,
        "owned_recipient_delivery_executed": False,
    }
    if imap_configured:
        try:
            retrieved, valid = _retrieve_draft()
            evidence["draft_retrieval_executed"] = retrieved
            evidence["draft_envelope_valid"] = valid
        except (OSError, ValueError, imaplib.IMAP4.error):
            pass
    if args.send and smtp_configured:
        try:
            evidence["owned_recipient_delivery_executed"] = _send_owned_test()
        except (OSError, ValueError, smtplib.SMTPException):
            pass
    output = Path(args.evidence_file)
    _write_evidence(output, evidence)
    print(json.dumps({key: value for key, value in evidence.items() if key != "observed_at"}, sort_keys=True))
    return 0 if all(
        evidence[key]
        for key in ("draft_retrieval_executed", "draft_envelope_valid", "owned_recipient_delivery_executed")
    ) else 2


if __name__ == "__main__":
    raise SystemExit(main())
