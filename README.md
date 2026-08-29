# Peel

Peel governs the boundary between what a sender believes an outbound workbook
contains and what the artifact can disclose. It inspects an `.xlsx` file with
deterministic Attacks, separates Findings from Repair safety, verifies any
approved Repair, and requires a separate Disclosure Approval before release.

This repository packages the two core journeys in scope for the hackathon:

- A clean workbook starts as an owned Gmail draft and ends as the exact
  verified attachment in an owned recipient mailbox.
- An unreferenced hidden worksheet produces a Finding and, when dependency
  analysis proves it safe, one atomic Repair Plan followed by Verification.

The completed and verified Gmail Mailbox Trigger from issue [#7] is an optional
supported intake route; the manual trigger remains the fallback. The
hidden-row/column and pivot-cache journeys from issues [#8] and [#9] remain
outside this submission qualification. Their implementation notes describe
their limits, but neither journey is an end-to-end supported scope claim here.
Sensitive Reveal values are cut; only metadata and an ephemeral, local Reveal
Reference are supported.

## Supported scope

The supported workbook profile is an unencrypted OOXML `.xlsx` no larger than
10 MiB, with package members the engine can inspect and verify. Macros,
external connections, unknown content-bearing members, malformed packages,
unsupported extensions, and any unproven fidelity result in Refusal. A clean
artifact is disclosed without rewriting its bytes.

The supported deterministic Finding for this submission is an unreferenced
hidden worksheet. Hidden rows or columns and pivot-cache content remain cuts
from the qualification profile. Each mechanism has explicit dependency and
fidelity limits; an artifact containing an unsupported or unproven mechanism
must not be presented as globally clean.
The Scope Assessment is advisory and one-way: `no_mismatch_found` means only
that no mismatch was found in bounded evidence; `mismatch` or
`insufficient_context` blocks progress and never grants authorization.

Repair Approval and Disclosure Approval are separate native approval-gated
tools. The generated presentation can explain a choice but cannot authorize a
Repair or Disclosure. Verification reruns the deterministic Attack, checks
the supported visible-content baseline and package relationships, and refuses
an artifact with a remaining Finding or unexplained change. An ambiguous mail
result is recorded as `delivery_unknown`; Peel never retries it automatically.

The precise domain vocabulary is in [`CONTEXT.md`](CONTEXT.md), and the
machine-checkable scope and privacy checks are in
[`scripts/submission_qualification.py`](scripts/submission_qualification.py).

## Setup

The demonstrated environment is WSL2/Ubuntu. Native Windows, macOS, hosted
deployment, and arbitrary mail providers are not supported claims.

```bash
node --version                 # demonstrated: v24.18.1
python3 --version              # demonstrated: 3.10.12
npm ci
python3 -m pip install -r requirements-gate.txt
cp .env.example .env
npm run typecheck
npm run build
```

Fill `.env` locally with the Cerebras, TrueForge, Daytona, IMAP, SMTP, and
owned-recipient settings. Never commit `.env`, paste its values into an issue,
or include it in evidence. The complete variable list and defaults are in
[`.env.example`](.env.example). Keep a TrueForge server running at the
configured `PEEL_TRUEFORGE_URL` for the live journey.

## Reproduce the live journey

Prepare one Gmail draft in the owned sender mailbox with exactly one
allowlisted recipient, a non-empty subject, one non-empty `Intended
disclosure:` field, and one `.xlsx` attachment no larger than 10 MiB. Build the
daemon, then run two consecutive rehearsals with the qualification wrapper:

```bash
TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm run build
python3 scripts/rehearse_submission.py \
  --repo-root "$PWD" \
  --evidence-dir /tmp/peel-rehearsals \
  --evidence-file /tmp/peel-submission-rehearsal-evidence.json
```

The wrapper runs [`scripts/live_clean_workbook.py`](scripts/live_clean_workbook.py)
twice. Each run retrieves the owned Gmail draft, stages the exact attachment,
uses TrueForge with the configured Cerebras model, executes production scan and
Verification in fresh Daytona sandboxes, and confirms the attachment hash in
the owned recipient mailbox. It shows the first native Disclosure Approval as
denied, checks zero SMTP activity after denial, obtains a fresh approval, and
then completes one approved Disclosure. It never uses the local Python engine
for production execution.

`rehearse_submission.py` exits `0` only for `demo_ready`: two consecutive
successful records with unchanged Git commit, clean worktree, and unchanged
local configuration. It writes bounded metadata only. Sachin receives the
stable recording sequence only after this result is observed; the sequence is
documented in [`docs/runbook.md`](docs/runbook.md).

The prior core live proof is recorded in [the issue #4 verification
comment](https://github.com/sivaratrisrinivas/peel/issues/4#issuecomment-5458840107).
The final issue #10 qualification run in WSL2/Ubuntu passed: two complete
rehearsals returned `demo_ready` with unchanged code and configuration.
The bounded records remain outside the repository under `/tmp`.

## Why and how submission qualification works

Submission qualification turns the working scope into a repeatable demo proof.
It checks the real mailbox, TrueForge/Cerebras, Daytona, approval, SMTP, and
recipient boundaries instead of relying on local test doubles. The wrapper
runs the live clean-workbook journey twice, while the privacy checker audits
all retained surfaces and repository hygiene. Both commands fail closed and
write only bounded metadata.

## Privacy qualification

Before calling the submission Demo-ready, inventory every retained observation
surface: logs, SQLite, TrueForge events, Cerebras requests, MCP transcripts,
Daytona artifact metadata, and reports. Put the inventory in a local ignored
JSON manifest and put one prohibited value per line in a local ignored corpus
file. Include exact local corpus files for the original attachment and any
other byte sequences that must not appear in retained surfaces. The Daytona
entry must state `"destroyed": true` after cleanup.

Run the bounded checker from WSL:

```bash
python3 scripts/privacy_qualification.py \
  --manifest /tmp/peel-privacy-manifest.json \
  --forbidden-file /tmp/peel-private-values.txt \
  --forbidden-file /tmp/peel-original-attachment.xlsx \
  --repo-root "$PWD" \
  --evidence-file /tmp/peel-privacy-evidence.json
```

The command inspects every listed surface without printing paths, workbook
values, Reveal values, draft bodies, credentials, or attachment bytes. It
decodes structured JSON and SQLite values, including JSON escaping and explicit
base64 payloads (including encoded structured objects), before checking them.
It also checks tracked-file hygiene for
generated workbooks, tracked `.env` files, and common secret signatures. A
missing surface, unproven Daytona cleanup, prohibited field, forbidden value,
or repository hygiene violation blocks the qualification. The corpus and raw
attachment remain outside the repository and are removed after the private
review.

The transformer edits only the planned workbook, relationship, and worksheet
relationship members. It also edits the content-types member when it must
remove a worksheet-specific override. Untouched ZIP member payloads stay
byte-for-byte identical. Verification reruns every enabled Attack, validates
relationships and content types, checks the visible-content baseline, and
reopens the candidate with the available readers. Any remaining Finding,
unexplained member change, parse failure, or reopen failure destroys the
candidate and ends the Run in Refusal. Hidden-row and hidden-column value
handling is described in issue #8 below. Pivot-cache support is limited to a
worksheet-sourced cache whose cached values are absent from visible worksheets;
external caches and unsupported OOXML extensions remain outside this supported
profile.

## Manual fallback and recovery

If mailbox polling is unavailable, the documented fallback is to upload the
attachment with `POST /v1/artifacts`, then call `POST /v1/commands` with a
strict `stage` command containing the same envelope and Artifact Reference.
The public HTTP and MCP boundaries use the same versioned command contract.
The mailbox watcher is optional and never scans, Repairs, authorizes, or
discloses an artifact itself.

## Issue #8: hidden row and column values

Peel scans values in hidden rows and columns and reports them as Findings,
even when the workbook may have a legitimate reason to hide them. Reveal uses
the same privacy and Scope Assessment checks as hidden worksheets. It is off by
default. When enabled, it stays local, expires after 60 seconds, and never puts
values in Run/MCP responses, SQLite, logs, or reports.

Peel can clear a concealed value only when it can prove that no supported
workbook feature uses it. The Repair Plan lists each exact cell and requires a
new native Repair Approval bound to the Run, revision, original Artifact
Reference, plan hash, and engine version. The dependency check covers visible
formulas, defined names, data validation, tables, charts, pivots, and package
relationships. Any dependency causes a visible Refusal.

For a concealed-cell action, the Repair changes only the planned worksheet
member. It keeps hidden dimensions, formatting, the original Artifact
Reference, and unrelated OOXML members. A mixed plan can also delete a hidden
worksheet; that action lists the affected workbook metadata, relationships,
content types, and worksheet members explicitly. Verification runs every
enabled Attack, checks the visible workbook content, and reopens the candidate.
Malformed or otherwise unprovable packages are refused before Repair.

Qodo reviewed [PR #16](https://github.com/sivaratrisrinivas/peel/pull/16#issuecomment-5460590356)
and reported zero bugs, rule violations, and skill insights. The review found
issues in shared-string handling, whole-range and 3-D references, missing cell
references, malformed XML, runtime validation, duplicate attributes, grid
bounds, defined-name scope, and mixed repair scope. The fixes are covered by
tests. No findings were dismissed or deferred.

## Issue #9: pivot-cache disclosure

Peel detects recoverable worksheet-sourced pivot-cache values when the source
worksheet is absent or hidden from the visible workbook. The Finding identifies
the cache-records member and count without exposing values in Run metadata.
When Reveal is enabled, at most five reconstructed rows are held locally for
60 seconds. A fresh native Repair Approval is required before Peel clears the
cache records and shared items.

Repair changes only the approved cache definition and records members. It
preserves the pivot table and every unrelated ZIP member, then reruns the
Attack, relationship/content-type checks, visible-content baseline, and package
reopen checks. External cache sources and incomplete or malformed cache
structures are refused.

The public fixture provenance and derivation are recorded in
[`docs/evidence/pivot-cache-fixture-2026-08-29.md`](docs/evidence/pivot-cache-fixture-2026-08-29.md).

Qodo's [initial review of PR #18](https://github.com/sivaratrisrinivas/peel/pull/18#issuecomment-5464175904)
found six High correctness bugs. The fixes are in commit `b1bc9bf`, covering
concealed cells, missing-record locations, cache-only proof, self-closing XML,
namespace prefixes, and cache-field alignment. Qodo's [follow-up on that
commit](https://github.com/sivaratrisrinivas/peel/pull/18#issuecomment-5464175904)
reports zero bugs, rule violations, and skill insights. No findings were
dismissed or deferred.

Qodo reviewed [PR #14](https://github.com/sivaratrisrinivas/peel/pull/14#issuecomment-5460451535)
and found zero bugs, rule violations, or requirement gaps. Its [final pass](https://github.com/sivaratrisrinivas/peel/pull/14#issuecomment-5460483810)
also found none. No findings were dismissed or deferred.

## Current status

Stop on any `failed`, `refused`, or `delivery_unknown` outcome. Preserve its
bounded evidence and failure code. A restart invalidates pending approvals; a
draft edit creates a new envelope revision; an artifact mismatch destroys the
candidate. Do not retry an ambiguous SMTP result. Reconcile the owned
recipient mailbox or obtain a fresh Disclosure Approval for a new attempt.
If a Daytona sandbox cannot be destroyed or its declared output cannot be
hash-verified, the Run is not Demo-ready.

## Architecture and security limits

The TypeScript daemon and one SQLite database are the sole authority for Run
state, envelope revisions, Artifact References, approvals, deduplication, and
delivery outcomes. TrueForge is orchestration and presentation, not a safety
authority. The Python workbook engine communicates through a strict versioned
JSON contract; production Attack, Repair, and Verification commands run in a
fresh Daytona sandbox.

Persistent records contain bounded metadata such as hashes, mechanism types,
locations, counts, states, authorization metadata, and delivery outcomes.
They must not contain workbook values, Reveal Samples, draft bodies,
credentials, or attachment bytes. Reveal values remain metadata-only until a
private transport and retention path is proven. Peel claims only absence of
the supported mechanisms that were successfully executed; it does not claim
that an arbitrary workbook is globally clean or completely inspected.

## Engineering trail

The project is engineered by Srinivas with Codex-assisted development. Sachin
is credited for demo production and editing after Demo-ready is reached; this
does not represent Sachin as an engineering contributor.

The repository's substantive slices received Qodo review before their merges:

| Slice | Pull request | Representative Qodo evidence |
| --- | --- | --- |
| Environment gate | [#11](https://github.com/sivaratrisrinivas/peel/pull/11) | [clean follow-up](https://github.com/sivaratrisrinivas/peel/pull/11#issuecomment-5447407850) |
| Gmail Mailbox Trigger | [#12](https://github.com/sivaratrisrinivas/peel/pull/12) | [clean follow-up](https://github.com/sivaratrisrinivas/peel/pull/12#issuecomment-5459293770) |
| Hidden worksheet Repair | [#13](https://github.com/sivaratrisrinivas/peel/pull/13) | [initial review](https://github.com/sivaratrisrinivas/peel/pull/13#issuecomment-5459968817), [follow-up](https://github.com/sivaratrisrinivas/peel/pull/13#issuecomment-5460285686) |
| Submission qualification | [#15](https://github.com/sivaratrisrinivas/peel/pull/15) | [Qodo review](https://github.com/sivaratrisrinivas/peel/pull/15#issuecomment-5460580573) |

For PR #15, Qodo reviewed the qualification gates and the follow-up fixes.
The linked review records the final status for the branch, including any
finding and its resolution. No findings were dismissed or deferred.

The current architecture and environment decision is
[ADR-0026](docs/adr/0026-current-architecture-and-environment-gate.md). The
full runbook is [`docs/runbook.md`](docs/runbook.md). The project is released
under the [MIT License](LICENSE).

The issue #8 hidden-row/column and issue #9 pivot-cache journeys remain cuts
from this submission profile. Sensitive Reveal values stay metadata-only until
a private transport and retention path is proven. LibreOffice-dependent reopen
checks remain cut because no supported binary was available on the gate host.
The issue #8 focused suites include deterministic pivot dependency fixtures; a
trusted raw `.xlsx` fixture with complete pivot-cache parts remains cut because
neither the repository nor the connected Drive account provided one.

## Deterministic checks

```bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp npm run build
TMPDIR=/tmp npm test
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest -q
python3 -m compileall -q scripts tests
git diff --check
```

`npm test` exercises the TypeScript HTTP/MCP and daemon boundaries. The Python
tests cover the production engine contract, live runner, external probes,
mailbox behavior, and final submission qualification without contacting live
services.
