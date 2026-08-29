#!/usr/bin/env python3
"""Return one eligible draft for the local TypeScript Mailbox Trigger."""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

from scripts.mail_gate_probe import (
    DEFAULT_DRAFT_CURSOR_FILE,
    MAX_DRAFT_SCAN_BATCH,
    DEFAULT_DRAFT_SCAN_BATCH,
    RetrievedDraft,
    _load_dotenv,
    _retrieve_eligible_draft,
)


def _wire_draft(draft: RetrievedDraft) -> dict[str, object]:
    return {
        "mailbox_account": draft.mailbox_account,
        "folder_uidvalidity": draft.folder_uidvalidity,
        "message_uid": draft.message_uid,
        "sender": draft.sender,
        "recipients": [draft.recipient],
        "subject": draft.subject,
        "body": draft.body,
        "attachments": [
            {
                "filename": draft.attachment_filename,
                "bytes_base64": base64.b64encode(draft.attachment_bytes).decode("ascii"),
            }
        ],
    }


def main() -> int:
    _load_dotenv()
    try:
        scan_batch = int(os.environ.get("IMAP_DRAFT_SCAN_BATCH", str(DEFAULT_DRAFT_SCAN_BATCH)))
        if not 1 <= scan_batch <= MAX_DRAFT_SCAN_BATCH:
            return 2
        cursor_path = Path(os.environ.get("PEEL_MAILBOX_CURSOR_FILE", str(DEFAULT_DRAFT_CURSOR_FILE)))
        draft = _retrieve_eligible_draft(max_messages=scan_batch, cursor_path=cursor_path)
    except Exception:
        return 2
    print(json.dumps({"version": "1", "draft": _wire_draft(draft) if draft else None}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
