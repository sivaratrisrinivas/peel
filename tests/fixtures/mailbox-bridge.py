import base64
import json

print(json.dumps({
    "version": "1",
    "draft": {
        "mailbox_account": "sender@example.test",
        "folder_uidvalidity": "uidvalidity-1",
        "message_uid": "message-1",
        "sender": "sender@example.test",
        "recipients": ["recipient@example.test"],
        "subject": "Workbook for review",
        "body": "Intended disclosure: the visible workbook only.",
        "attachments": [{
            "filename": "workbook.xlsx",
            "bytes_base64": base64.b64encode(b"xlsx").decode("ascii"),
        }],
    },
}))
