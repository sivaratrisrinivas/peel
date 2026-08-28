#!/usr/bin/env python3
"""Deliver one already-authorized Disclosure envelope over configured SMTP."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import smtplib
import ssl
import sys
from email.message import EmailMessage
from typing import Any


MAX_ARTIFACT_BYTES = 10 * 1024 * 1024


def _secret(name: str) -> str:
    return re.sub(r"\s+", "", os.environ.get(name, ""))


def _request() -> tuple[dict[str, Any], bytes]:
    value = json.load(sys.stdin)
    if not isinstance(value, dict):
        raise ValueError("request must be an object")
    required = ("sender", "recipient", "subject", "body", "idempotency_key", "bytes_base64")
    if any(not isinstance(value.get(key), str) or not value[key].strip() for key in required):
        raise ValueError("invalid SMTP request")
    if not isinstance(value.get("attachment"), dict):
        raise ValueError("invalid attachment")
    attachment = value["attachment"]
    filename = attachment.get("filename")
    media_type = attachment.get("media_type")
    expected_hash = attachment.get("sha256")
    if (
        not isinstance(filename, str)
        or "/" in filename
        or "\\" in filename
        or not filename.lower().endswith(".xlsx")
        or media_type != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        or not isinstance(expected_hash, str)
        or not re.fullmatch(r"[0-9a-f]{64}", expected_hash)
    ):
        raise ValueError("invalid attachment identity")
    try:
        payload = base64.b64decode(value["bytes_base64"], validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("attachment is not valid base64") from error
    if not payload or len(payload) > MAX_ARTIFACT_BYTES or hashlib.sha256(payload).hexdigest() != expected_hash:
        raise ValueError("attachment identity failed before SMTP delivery")
    return value, payload


def _message(value: dict[str, Any], payload: bytes) -> EmailMessage:
    attachment = value["attachment"]
    message = EmailMessage()
    message["From"] = value["sender"]
    message["To"] = value["recipient"]
    message["Subject"] = value["subject"]
    message["X-Peel-Disclosure-Idempotency-Key"] = value["idempotency_key"]
    message.set_content(value["body"])
    message.add_attachment(
        payload,
        maintype="application",
        subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=attachment["filename"],
    )
    return message


def main() -> int:
    try:
        value, payload = _request()
        host = os.environ.get("SMTP_HOST", "")
        username = os.environ.get("SMTP_USERNAME", "")
        password = _secret("SMTP_PASSWORD")
        if not host or not username or not password:
            raise ValueError("SMTP configuration is incomplete")
        message = _message(value, payload)
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(
            host,
            int(os.environ.get("SMTP_PORT", "465")),
            context=context,
            timeout=30,
        ) as client:
            client.login(username, password)
            refused = client.send_message(message)
        print(json.dumps({"status": "rejected" if refused else "accepted"}, separators=(",", ":")))
        return 0
    except (OSError, ValueError, smtplib.SMTPException):
        print(json.dumps({"status": "ambiguous"}, separators=(",", ":")))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
