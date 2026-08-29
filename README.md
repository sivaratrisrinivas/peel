# Peel

Peel checks what an Excel workbook can disclose before a sender releases it.
It finds concealed data with deterministic Attacks, proposes an explicit Repair,
checks the repaired artifact against the original visible content, and releases
the result only after the required human decisions.

The environment gate had to pass before dependent product work could begin.
The issue #3 safety kernel is now implemented as a TypeScript daemon with a
SQLite authority and deterministic fake Artifact, workbook-engine, and mail
adapters. Issue #4 adds the live Daytona, mailbox, TrueForge, and SMTP journey;
the fake adapters remain deterministic test doubles and never send external
mail.

Issue #3 is complete. The public daemon covers the clean workbook workflow,
strict command and engine contracts, artifact integrity, revision invalidation,
approval expiry, denial, duplicate delivery, and ambiguous delivery. HTTP and
MCP expose the same command contract. The fake mail adapter records accepted
messages but never sends mail outside the process.

## Live clean-workbook journey

Issue #4 is exercised by `scripts/live_clean_workbook.py`. It retrieves the
newest eligible Gmail draft over IMAP, stages its attachment through the daemon,
and asks a real TrueForge/Cerebras session to run `scan`, `verify`, and
`request_disclosure` through the daemon MCP endpoint. The direct `send_email`
tool is configured as a native TrueForge approval boundary: the first approval
is denied and recorded safely, then a fresh approval is required before SMTP
delivery. The daemon's live engine adapter uses a fresh Daytona sandbox for
each engine command and downloads only the declared verified artifact. The
runner confirms exactly one matching attachment in the recipient mailbox and
writes only bounded evidence to `/tmp/peel-live-clean-evidence.json`.

Run it from the supported WSL2/Ubuntu environment after building the daemon,
with the existing TrueForge server running and an eligible draft already saved:

```bash
bash -ic 'TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm run build && python3 scripts/live_clean_workbook.py'
```

If the WSL shell does not expose Node to child processes, set `PEEL_NODE_BIN`
to the absolute WSL Node path. Required local configuration is listed in
`.env.example`; the recipient IMAP variables are required when the owned
recipient uses a separate mailbox. The run exits `0` only after the recipient
confirms exactly one message with the expected SHA-256, and exits `2` with
bounded failed-state evidence otherwise. It never falls back to the local
Python engine in live mode. The runner supplies valid command identities and
uses bounded Cerebras rate-limit backoff only before a tool action starts; a
completed tool response is never replayed.

## Optional Gmail Mailbox Trigger

Issue #7 adds an optional serial Gmail/IMAP watcher. It is disabled by default
so the manual staging route remains the demo fallback. When enabled, the
watcher polls the configured Drafts mailbox every five seconds, accepts only
one `.xlsx` attachment no larger than 10 MiB, one allowlisted recipient, a
non-empty subject, and exactly one non-empty `Intended disclosure:` field. It
uploads an eligible attachment to the local daemon and signals only the
opaque Artifact Reference, envelope revision identity, and bounded Run
metadata. It never scans, Repairs, authorizes, or discloses an artifact.

The watcher is serial and SQLite-backed: an unchanged draft is deduplicated,
an autosave edit creates a new envelope revision and invalidates prior
judgment and authorization, an IMAP `UIDVALIDITY` change creates a distinct
trigger identity, and an unrelated draft waits while one Run is active. The
bridge scans a default batch of 25 UIDs per poll, uses a cursor scoped to the
IMAP host, account, folder, and UIDVALIDITY to wrap through older drafts, and
fetches full messages only after lightweight header checks; the batch can be
tuned up to 100 with `IMAP_DRAFT_SCAN_BATCH`.
Malformed or half-authored drafts are ignored without starting a Run. The
watcher result and daemon log contain no draft body or attachment bytes.

After exporting the recipient and IMAP settings in the supported WSL2 shell,
run the live one-Run smoke check:

```bash
TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm run build
PEEL_OWNED_RECIPIENT=you@example.com npm run mailbox-smoke
```

The smoke command exits `0` only when one eligible draft starts one Run and a
second poll is deduplicated to that same Run. It exits `2` with bounded
metadata when mail configuration, retrieval, or eligibility proof is missing.
For continuous optional polling alongside the local daemon, set
`PEEL_MAILBOX_WATCH=1` before `npm start`; `PEEL_MAILBOX_POLL_INTERVAL_MS`
may override the five-second interval.

The manual fallback remains available through `POST /v1/artifacts` followed by
`POST /v1/commands` with a `stage` command. Its existing public-boundary tests
continue to cover direct staging without the watcher.

Issue #5 adds the concealed-data Attack and one-way Scope Assessment. The
hidden-worksheet Attack reports mechanism, location, and count as public Finding
metadata. `mismatch`, `insufficient_context`, and model failure fail closed;
`no_mismatch_found` is only an assessment result and never authorization. An
eligible Finding now enters the separate issue #6 Repair Approval boundary;
unsupported or unproven Findings remain visible Refusals. Without an explicitly
configured Scope Assessor, the daemon returns `insufficient_context` rather than
silently treating a Finding as aligned.

Sensitive Reveal values are disabled by default. A test or explicitly proven
private local deployment may enable the short-lived Reveal path; it keeps up to
five recovered rows per Finding in daemon memory, returns only an opaque
Run-bound reference through the command response, and serves values only from
`GET /v1/runs/<run-id>/reveals/<reference>`. Reveal values are not placed in
TrueForge/MCP responses, SQLite, or persistent reports.

## Issue #6 hidden-worksheet repair

Issue #6 supports repairing an unreferenced `hidden` or `veryHidden` worksheet
in an accepted OOXML package. The engine creates one complete Repair Plan with
dependency analysis for visible formulas, defined names, data validation,
tables, charts, pivots, package relationships, macros, and external
connections. The plan also names every capability loss. Any dependency,
unsupported package member, macro, external connection, additional concealed
mechanism, or unresolved worksheet relationship produces a Refusal.

The native MCP `apply_repair` tool is the only way to run a Repair. Its approval
binds the Run, envelope revision, original artifact SHA-256, canonical Repair
Plan SHA-256, and engine version. If approval expires, the run restarts or
replays, or the revision changes, Peel leaves the original Artifact Reference
unchanged. An approved plan runs in a fresh Daytona sandbox in live mode and
produces a new candidate. Tests use a deterministic fake engine for the same
contract.

The transformer edits only the planned workbook, relationship, and worksheet
relationship members. It also edits the content-types member when it must
remove a worksheet-specific override. Untouched ZIP member payloads stay
byte-for-byte identical. Verification reruns the hidden-worksheet Attack,
validates relationships and content types, checks the visible-content baseline,
and reopens the candidate with the available readers. Any remaining Finding,
unexplained member change, parse failure, or reopen failure destroys the
candidate and ends the Run in Refusal. This issue does not repair hidden rows or
columns, pivot caches, macros, external connections, or unsupported OOXML
extensions.

The initial [Qodo review](https://github.com/sivaratrisrinivas/peel/pull/13#pullrequestreview-5056601225)
reported four High-severity and one Medium-severity correctness findings. The
fixes landed in commit `61d5852`. The [final Qodo update](https://github.com/sivaratrisrinivas/peel/pull/13#issuecomment-5460222193)
for the completed branch reports zero bugs, rule violations, requirement gaps,
or skill insights. No findings were dismissed or deferred.

## Current status

Issue #5 is complete. Its public-boundary tests cover legitimate-looking and
suspicious hidden worksheets, missing context, scope mismatch, model failure,
private Reveal expiry, and the handoff into Repair Approval. The default path
keeps Reveal off, and a refused Run has no Repair or Disclosure path.

Issue #7 adds an optional Gmail/IMAP Mailbox Trigger. The WSL fake-IMAP and
public-boundary tests pass. The live owned-mailbox smoke also passed on
2026-08-29 against the configured mailbox: the first poll started one Run and
the second poll deduplicated that same Run. The smoke output contains only
bounded metadata.

Qodo's initial review is recorded on [PR #12](https://github.com/sivaratrisrinivas/peel/pull/12#issuecomment-5459264401)
for commit `0faa8bc`. Its follow-up review on [PR #12](https://github.com/sivaratrisrinivas/peel/pull/12#issuecomment-5459293770)
found and verified fixes for restart state, bridge and socket timeouts,
shutdown ordering, UID scanning and cursor scope, repeated draft observation,
and fetch retries. The final update through `d490716` reports zero bugs, rule
violations, or skill insights. No findings were dismissed or deferred.

Issue #4 is complete. The WSL live journey passed on 2026-08-29 with the
TrueForge 0.1.4 Cerebras runtime, fresh Daytona execution, native denial with
zero SMTP activity, fresh approval, and one matching owned-recipient message.

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

The kernel exposes the same versioned command boundary to both HTTP and MCP:

- `POST /v1/artifacts` registers a bounded `.xlsx` byte stream and returns an
  opaque Artifact Reference.
- `POST /v1/commands` accepts `stage`, `scan`, `apply_repair`, `verify`,
  `request_disclosure`, and `respond_disclosure` commands.
- `GET /v1/runs/<run-id>` returns bounded Run metadata and evidence.
- `POST /mcp` exposes the same commands through `initialize`, `tools/list`,
  and `tools/call`; live TrueForge sessions also receive the direct native
  approval-gated `send_email` tool.

Every command is versioned, strict, bound to an expected Run state and
identity, and consumed once by SQLite. The clean path preserves the original
artifact hash, records a native-approval-shaped Disclosure decision, and
requires a fresh approval after denial. The public response never includes
draft bodies or workbook values; the in-memory fake adapters hold bytes only
for the active deterministic test Run.

Repair uses targeted ZIP and XML changes. `openpyxl` can inspect a workbook and
help with reopen checks, but it does not save demo-critical repaired workbooks.
A whole-workbook save can change or discard pivot and extension parts.

The safety rules are simple:

- An Attack reports a Finding when its concealed-data mechanism is present.
- A Repair creates a new artifact and needs separate Repair Approval.
- A Repair Plan enumerates dependencies and declared capability losses before
  any transformation is authorized.
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
PEEL_TRUEFORGE_EVIDENCE_FILE=/tmp/peel-trueforge-evidence.json \
PEEL_DAYTONA_EVIDENCE_FILE=/tmp/peel-daytona-evidence.json \
PEEL_MAIL_EVIDENCE_FILE=/tmp/peel-mail-evidence.json \
python3 scripts/environment_gate.py --pull-request 11 --format json
```

The command exits `0` for `GO` and `2` for `NO-GO`. Any mandatory failure
blocks dependent implementation. Optional cuts must remain visible in the
report.

## Tests and checks

The TypeScript kernel requires Node.js 22.5 or newer because it uses the
built-in `node:sqlite` API:

```bash
npm install
npm run typecheck
npm run build
npm test
npm audit
```

Run these commands in the supported WSL2/Ubuntu environment. Vitest reads only
`tests/**/*.test.ts`, so a build in `dist/` cannot be collected as a second
copy of the test suite.

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
