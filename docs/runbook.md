# Peel submission runbook

This is the operator runbook for the issue #10 submission qualification. It
uses the domain terms from [`CONTEXT.md`](../CONTEXT.md): a workbook release is
a Disclosure, a safe transformation is a Repair, and an unsuccessful safety
proof is a Refusal.

## Release scope

The two core journeys in scope are:

1. Clean `.xlsx` Disclosure through an owned Gmail draft, TrueForge with
   Cerebras, fresh Daytona execution, native Disclosure denial, fresh native
   approval, and owned-recipient confirmation by exact attachment hash.
2. Hidden-worksheet inspection and Repair when the worksheet is unreferenced,
   the complete dependency analysis is empty, the atomic plan is approved, and
Verification proves the supported visible baseline.

The hidden-row/column and pivot-cache journeys from issues #8 and #9 remain
outside this submission qualification. They are not counted as supported
optional journeys until they have their own end-to-end qualification evidence.

The completed and verified Gmail Mailbox Trigger from issue #7 is an optional
intake route. It is not required for the core qualification and can be used
when polling is available; the manual trigger remains the fallback.

The following limits remain explicit cuts for this submission:

- Hidden rows or columns outside the supported dependency checks.
- External, incomplete, or otherwise unproven pivot-cache structures.
- Sensitive Reveal values: only metadata and a short-lived local reference are
  retained; no provider-visible Reveal values are supported.
- LibreOffice-dependent reopen coverage: not part of the demonstrated host
  qualification.

Do not describe a workbook as globally clean. The claim is limited to the
supported mechanism(s) that actually executed and passed Verification.

## Demonstrated WSL environment

The recorded WSL2/Ubuntu environment is:

| Component | Demonstrated version or policy |
| --- | --- |
| WSL distribution | Ubuntu `22.04.5 LTS` (Jammy) |
| Node.js | `v24.18.1` |
| Python | `3.10.12` |
| TrueForge | `0.1.4` |
| Cerebras model | `gemma-4-31b` through `https://api.cerebras.ai/v1`; `gpt-oss-120b` remains preferred but its deferred continuation returned HTTP 400 in the recorded runtime |
| Daytona CLI | `v0.190.0` |
| Daytona Python SDK | pinned `0.207.0` |
| Cerebras Python SDK | pinned `1.91.0` |
| Workbook readers | `openpyxl 3.1.5`, `xlsxwriter 3.2.9` |
| TypeScript toolchain | TypeScript `5.7.2`, Vitest `4.1.11` |

These versions describe the demonstrated WSL environment, not a promise of
native Windows, macOS, hosted deployment, or arbitrary provider support.

## Setup and preflight

From the issue worktree:

```bash
node --version
python3 --version
npm ci
python3 -m pip install -r requirements-gate.txt
cp .env.example .env
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp npm run build
```

Configure `.env` with local credentials and owned mailbox settings. The sender
draft must have one allowlisted recipient, a non-empty subject, exactly one
non-empty `Intended disclosure:` field, and exactly one `.xlsx` attachment no
larger than 10 MiB. Keep the TrueForge server running at
`PEEL_TRUEFORGE_URL`.

Do not start a recording after one successful run. Run the qualification
wrapper below, inspect its bounded result, and proceed only when it reports
`demo_ready`.

## Stable demo sequence

The sequence is deliberately fixed so the audience sees the governed
workflow:

1. Show the eligible owned Gmail draft and its stated Claimed Scope without
   copying its body or workbook values into the recording transcript.
2. Start `scripts/rehearse_submission.py`. It performs the mailbox trigger,
   exact Artifact Reference transfer, fresh Daytona scan/Verification, and
   TrueForge/Cerebras serial tool loop.
3. Show the first native Disclosure Approval and the denied Disclosure result.
   Show the bounded Run state and the SMTP audit count of zero.
4. Show the fresh Disclosure Approval for the same Run and exact verified
   artifact. Approve it through the native `send_email` boundary.
5. Show the owned recipient mailbox with exactly one matching message and the
   expected attachment SHA-256. Do not display workbook values.
6. Repeat the complete sequence once more without changing code or
   configuration. Only after both records pass is the sequence stable for
   Sachin to record and edit.

The wrapper command is:

```bash
python3 scripts/rehearse_submission.py \
  --repo-root "$PWD" \
  --evidence-dir /tmp/peel-rehearsals \
  --evidence-file /tmp/peel-submission-rehearsal-evidence.json
```

It exits `0` only when two consecutive rehearsals pass. It captures child
stdout/stderr in memory and writes only bounded qualification metadata.

## Manual fallback

Mailbox polling is optional. If it is unavailable, keep the same envelope and
stage manually:

1. Upload the exact attachment to `POST /v1/artifacts` with the
   `x-artifact-filename` header.
2. Copy only the returned opaque Artifact Reference and SHA-256 into a strict
   `stage` command sent to `POST /v1/commands`.
3. Continue with `scan`, `verify`, `request_disclosure`, and the native
   `send_email` approval path. Never call a local Python engine as a live
   substitute.

The manual fallback is a trigger fallback only. It does not bypass Scope
Assessment, Repair Approval, Verification, Disclosure Approval, or the
allowlisted recipient check.

## Privacy qualification

Create a local ignored manifest that lists every retained observation surface.
Use metadata-only paths for the Daytona entry and mark cleanup explicitly:

```json
{
  "schema_version": "1",
  "entries": [
    {"category": "logs", "path": "/tmp/peel-privacy/log.json"},
    {"category": "sqlite", "path": "/tmp/peel-privacy/peel.sqlite"},
    {"category": "trueforge_events", "path": "/tmp/peel-privacy/trueforge.json"},
    {"category": "cerebras_requests", "path": "/tmp/peel-privacy/cerebras.json"},
    {"category": "mcp_transcripts", "path": "/tmp/peel-privacy/mcp.json"},
    {"category": "daytona_artifacts", "path": "/tmp/peel-privacy/daytona.json", "destroyed": true},
    {"category": "reports", "path": "/tmp/peel-privacy/report.json"}
  ]
}
```

The private corpus contains the exact original attachment bytes, known
workbook values, any permitted Reveal values, the draft body, and local
credential values. Keep the corpus outside the worktree. Run:

```bash
python3 scripts/privacy_qualification.py \
  --manifest /tmp/peel-privacy/manifest.json \
  --forbidden-file /tmp/peel-privacy/private-values.txt \
  --forbidden-file /tmp/peel-privacy/original-attachment.xlsx \
  --repo-root "$PWD" \
  --evidence-file /tmp/peel-privacy/evidence.json
```

The checker requires all seven surfaces, confirms Daytona cleanup, searches
their bytes and decoded JSON/SQLite values (including JSON escapes and explicit
base64 payloads, including encoded structured objects) without returning matches,
rejects prohibited persistent field
names case-insensitively, and checks tracked repository hygiene. A pass is
bounded metadata, not a copy of the private corpus.

## Failure recovery

- `failed`: preserve the failure code and stop the recording. Fix the external
  prerequisite, then start a new Run.
- `refused`: treat the artifact as not disclosable. Do not override an
  unsupported container, remaining Finding, dependency, or fidelity failure.
- `delivery_unknown`: do not resend automatically. Reconcile the owned
  recipient mailbox or obtain a fresh Disclosure Approval for a distinct
  attempt.
- Daemon restart: pending approvals are invalidated. A clean verified Run may
  resume at the approval boundary, but a pending Repair is Refusal and the
  original Artifact Reference remains unchanged.
- Draft mutation: any recipient, subject, body, Claimed Scope, filename, or
  attachment change creates a new envelope revision and invalidates old
  judgments and approvals.
- Daytona failure: if sandbox destruction, declared-output transport, or hash
  verification is not proven, refuse the Run and do not use local Python as a
  production fallback.
- TrueForge/Cerebras failure: do not silently switch provider or model. Record
  the bounded failure and restart only after the explicitly configured runtime
  is healthy.

## Evidence handling and credits

Keep only bounded evidence records in `/tmp` during qualification. Do not
commit generated workbooks, `.env`, private corpus files, credentials, draft
bodies, workbook values, attachment bytes, or provider transcripts containing
them. The project is engineered by Srinivas with Codex-assisted development;
Sachin owns demo recording and editing after `demo_ready`.
