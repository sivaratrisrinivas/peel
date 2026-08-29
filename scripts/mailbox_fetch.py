#!/usr/bin/env python3
"""Return one eligible draft for the local TypeScript Mailbox Trigger."""

from __future__ import annotations

import base64
import json

from scripts.mail_gate_probe import RetrievedDraft, _load_dotenv, _retrieve_eligible_draft


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
        draft = _retrieve_eligible_draft()
    except Exception:
        return 2
    print(json.dumps({"version": "1", "draft": _wire_draft(draft) if draft else None}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
