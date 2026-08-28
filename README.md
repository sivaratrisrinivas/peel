# Peel

Peel checks what an Excel workbook can disclose before a sender releases it.
It finds concealed data with deterministic Attacks, proposes an explicit Repair,
checks the repaired artifact against the original visible content, and releases
the result only after the required human decisions.

This repository currently holds the architecture, cross-language boundaries,
and environment gate for the first implementation ticket. The gate had to pass
before dependent product work could begin. The production daemon and workbook
engine described below are the planned implementation boundary, not a claim
that those services already live in this checkout.

## Current status

Issue #2 is complete. The final live gate passed on 2026-08-28 at commit
`d4a9342187a74d6f686442bccc2a665e110ce4e`.

| Gate | Result | What was checked |
| --- | --- | --- |
| GitHub and Qodo | Pass | Public repository access, PR #11 at the checkout commit, and the exact-commit Qodo Code Review publication with all findings resolved |
| TrueForge and Cerebras | Pass | A live serial tool loop, native `send_email` denial, runtime model/provider identity, and zero side effects using configured `gemma-4-31b` |
| Daytona | Pass | Fresh sandbox creation, sentinel upload, declared hash command, verified download, and destruction |
| Owned mail | Pass | Strict Gmail draft retrieval and one owned-recipient SMTP delivery |

The gate records booleans and bounded metadata. It does not record workbook
values, draft bodies, attachment bytes, mailbox addresses, credentials, or
sandbox paths.

Three optional routes remain cuts. Sensitive Reveal values stay metadata-only
until a private transport and retention path is proven. LibreOffice-dependent
reopen checks remain cut because no supported binary was available on the gate
host. Pivot-fixture coverage remains cut because neither the repository nor the
connected Drive account provided a trusted raw `.xlsx` fixture with the needed
pivot-cache parts.

## Architecture

Peel uses one TypeScript daemon and one SQLite database as the authority for Run
state, artifact identities, approvals, deduplication, and delivery outcomes.
TrueForge presents the workflow and its human decision points. TrueForge events
never authorize a Repair or Disclosure.

The Python workbook engine communicates through a versioned JSON contract. A
production engine command runs in a fresh Daytona sandbox. Each materialization
boundary checks the artifact SHA-256, and the original artifact remains
unchanged.

The mailbox watcher accepts one unambiguous draft envelope. It identifies the
attachment and passes an opaque Artifact Reference into the workflow. IMAP and
SMTP configuration stays outside the engine and orchestration contracts.

Repair uses targeted ZIP and XML changes. `openpyxl` can inspect a workbook and
help with reopen checks, but it does not save demo-critical repaired workbooks.
A whole-workbook save can change or discard pivot and extension parts.

The safety rules are simple:

- An Attack reports a Finding when its concealed-data mechanism is present.
- A Repair creates a new artifact and needs separate Repair Approval.
- Verification reruns the Attacks and checks the visible-content baseline.
- Disclosure needs a separate approval bound to the exact artifact and recipient.
- A denied Disclosure Attempt produces no SMTP activity.
- Unsupported or unproven content produces a Refusal, not a best-effort result.

## TrueForge and Cerebras

TrueForge uses the custom Cerebras provider at
`https://api.cerebras.ai/v1`. The configured models are `gpt-oss-120b` and
`gemma-4-31b`. The final proof exercised `gemma-4-31b` because the local
TrueForge 0.1.4 runtime returned HTTP 400 while continuing the deferred tool
turn for `gpt-oss-120b`. The fallback was accepted only after the same runtime
identity, serial-tool, native-denial, and zero-side-effect checks passed.

The probe uses a local no-op MCP fixture. Its `send_email` handler records an
unexpected invocation but never sends mail. The fixture status file contains
only counters and booleans.

Keep the existing TrueForge server running and run:

```bash
python3 scripts/trueforge_gate_probe.py \
  --model gemma-4-31b \
  --evidence-file /tmp/peel-trueforge-evidence.json
```

## Google Drive in the hackathon workflow

The connected Google Drive plugin is an optional fixture and review tool. Use
it to find or fetch a sanitized raw `.xlsx` file, keep its Drive revision as
provenance, and verify its SHA-256 after download. It can also hold a
metadata-only verification report for a human reviewer.

Do not convert a fixture into native Google Sheets before inspection. The
converted file is a different artifact and cannot prove that Peel preserved the
original OOXML package. Drive is not the source of Run state, approvals, or
artifact identity, and it is not a formula or fidelity oracle.

## Running the gate

Install the pinned gate dependencies in the supported WSL2/Ubuntu environment:

```bash
python3 -m pip install -r requirements-gate.txt
cp .env.example .env
```

Fill `.env` with local values. Never commit `.env` or paste its values into an
issue, log, evidence file, or workbook report.

Run the external probes when their services are configured:

```bash
python3 scripts/daytona_gate_probe.py \
  --evidence-file /tmp/peel-daytona-evidence.json

python3 scripts/mail_gate_probe.py \
  --send \
  --evidence-file /tmp/peel-mail-evidence.json
```

Use `--send` only when `PEEL_OWNED_RECIPIENT` is a mailbox you own. The mail
probe expects a draft with exactly one `.xlsx` attachment, one recipient, one
non-empty subject, and one non-empty `Intended disclosure:` field.

Run the consolidated check from the checkout under review:

```bash
SMTP_USERNAME="$YOUR_OWNED_SMTP_ADDRESS" \
PEEL_TRUEFORGE_EVIDENCE_FILE=/tmp/peel-trueforge-evidence.json \
PEEL_DAYTONA_EVIDENCE_FILE=/tmp/peel-daytona-evidence.json \
PEEL_MAIL_EVIDENCE_FILE=/tmp/peel-mail-evidence.json \
python3 scripts/environment_gate.py --pull-request 11 --format json
```

The command exits `0` for `GO` and `2` for `NO-GO`. Any mandatory failure
blocks dependent implementation. Optional cuts must remain visible in the
report.

## Tests and checks

Run the deterministic checks without loading unrelated host pytest plugins:

```bash
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest -q
mypy scripts tests
python3 -m compileall -q scripts tests
git diff --check
```

The final issue #2 run passed 18 tests, mypy over the seven gate and probe
modules, Python compilation, and `git diff --check`.

## Repository guide

- [`CONTEXT.md`](CONTEXT.md) defines the project's domain language.
- [`docs/adr/README.md`](docs/adr/README.md) explains which architecture record is current.
- [`docs/adr/0026-current-architecture-and-environment-gate.md`](docs/adr/0026-current-architecture-and-environment-gate.md) records the current architecture and gate decision.
- [`docs/evidence/live-proof-records.md`](docs/evidence/live-proof-records.md) describes the evidence contract and probe commands.
- [`docs/evidence/environment-gate-2026-08-28-final.md`](docs/evidence/environment-gate-2026-08-28-final.md) records the final bounded live result.
- [`requirements-gate.txt`](requirements-gate.txt) pins the external probe dependencies.
- [`.env.example`](.env.example) lists local configuration names without values.

Engineering is by Srinivas with Codex-assisted development. Sachin handles
demo recording and editing.
