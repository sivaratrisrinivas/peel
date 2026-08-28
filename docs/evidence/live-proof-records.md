# Live proof records

The environment gate accepts mandatory integration evidence only from versioned JSON records produced by an explicit live probe. Credentials, message bodies, workbook values, command output, and sandbox paths must not be copied into a record.

Set these local, ignored variables before running the gate:

```text
PEEL_TRUEFORGE_EVIDENCE_FILE=/tmp/peel-trueforge-evidence.json
PEEL_DAYTONA_EVIDENCE_FILE=/tmp/peel-daytona-evidence.json
PEEL_MAIL_EVIDENCE_FILE=/tmp/peel-mail-evidence.json
```

Each record must contain `schema_version: "1"` and a matching `probe` name. Missing, malformed, or unversioned records fail closed.

## TrueForge and Cerebras

The record must be produced after a real TrueForge turn using Cerebras `gpt-oss-120b` at `https://api.cerebras.ai/v1`. The tool-running turn must set `parallel_tool_calls` to `false` and omit response formatting. The run must execute a serial tool loop, request native approval for `send_email`, deny it, and independently check that no SMTP activity or other side effect occurred.

Required fields:

```json
{
  "schema_version": "1",
  "probe": "trueforge_cerebras",
  "model_name": "gpt-oss-120b",
  "provider_base_url": "https://api.cerebras.ai/v1",
  "parallel_tool_calls": false,
  "response_format_on_tool_turn": false,
  "serial_tool_loop_executed": true,
  "native_denial_executed": true,
  "denied_tool_name": "send_email",
  "side_effects_checked": true,
  "side_effects_observed": false
}
```

## Daytona

Run `scripts/daytona_gate_probe.py` with a real API key. It creates a uniquely named fresh sandbox, uploads a harmless sentinel, runs a declared `sha256sum` command, downloads the sentinel, compares hashes, and waits for deletion before writing the record.

## Owned mail

Run `scripts/mail_gate_probe.py` after placing a draft with exactly one `.xlsx` attachment, a non-empty subject, and an `Intended disclosure:` body field in the owned sender mailbox. The probe retrieves the draft over IMAP. Pass `--send` only when `PEEL_OWNED_RECIPIENT` is an address you own; it submits one uniquely identified SMTP test message to that recipient.

The gate records only booleans from these probes and never records the mailbox address, draft body, attachment bytes, recipient, or credentials.
