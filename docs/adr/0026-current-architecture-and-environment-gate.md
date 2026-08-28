# ADR-0026: Current architecture and environment gate

- Status: Accepted — current
- Date: 2026-08-28
- Supersedes: conflicting portions of draft ADRs 0001–0025

## Context

The first implementation ticket must establish one coherent safety architecture and prove the external runtime needed by every dependent ticket. The earlier ADRs were deliberately short design notes and contain conflicts about production execution, state authority, approval surfaces, and privacy. Treating all of them as current would make a fail-closed implementation impossible to review.

## Decision

Peel has one TypeScript daemon and one SQLite database. The daemon is the sole authority for Run state, envelope revisions, artifact identities, authorization consumption, deduplication, and delivery outcomes. TrueForge is an orchestration and presentation client; its turns, cards, forms, and events are never safety state and never authorize a Repair or Disclosure.

The Python workbook engine communicates through a versioned, strict JSON contract. Production Attack, Repair, and Verification commands always run in a fresh Daytona sandbox created from a prepared snapshot. A local Python adapter is permitted for deterministic tests only and is not a second production path. Each Run receives an isolated sandbox; artifacts are transferred through opaque Artifact References and SHA-256 checks at each materialization boundary; the sandbox is destroyed after declared outputs and evidence are retrieved.

`apply_repair` and `send_email` are direct native approval-gated tools. Generated UI can explain a choice but cannot authorize it. Repair Approval and Disclosure Approval are separate, bound to the Run and the exact immutable identities required by the specification. Denial performs no side effect. A confirmed successful Disclosure is deduplicated by Disclosure Fingerprint; an ambiguous SMTP result becomes `delivery_unknown` with no automatic retry.

Cerebras Scope Assessment is a one-way advisory veto. `mismatch`, `insufficient_context`, model failure, stale identity, or missing evidence blocks progress. A positive result means only that no mismatch was found in bounded evidence; it is never proof of safety or permission. Reveal values remain outside TrueForge, Cerebras, tool transcripts, logs, reports, SQLite, and repaired artifacts. If a private, short-lived local Reveal path cannot be proven, sensitive Reveal values are cut and only metadata remains.

The supported claim is limited to mechanisms that Peel supports and successfully executes. Unknown or unsupported content-bearing workbook features, unproven fidelity, or failed Verification produce Refusal rather than a globally “clean” result. Untouched OOXML ZIP members remain byte-identical; changed members receive targeted semantic checks.

## Environment gate

The gate is a prerequisite for dependent implementation. A mandatory gate passes only after its live behavior is observed and recorded; configuration presence alone is not proof.

| Gate | Required evidence | Current result |
| --- | --- | --- |
| GitHub and Qodo | Public repository access and a Qodo review on the repository | Fail — the connector proved public access, but no Qodo-reviewed pull request exists; local `gh` authentication is unavailable |
| TrueForge and Cerebras | Serial tool loop with `gpt-oss-120b`, native approval denial, and zero side effects | Fail — no runtime proof |
| Daytona | Fresh sandbox, upload, declared command, hash-verified download, and destruction | Fail — no runtime proof |
| Owned mail | Owned Gmail draft retrieval and owned-recipient SMTP delivery | Fail — the Gmail connector returned owned-account draft metadata, but provider-neutral IMAP retrieval and SMTP delivery were not proved |
| Sensitive Reveal | Private transcript/retention path | Cut — metadata-only policy applies until proven |
| LibreOffice | Availability for supported-profile reopen checks | Pass — temporary user-local bundle; system package remains unavailable |
| Pivot fixture | Inspected trusted package with the required pivot-cache structures | Cut — no trusted fixture is present |

Any mandatory failure keeps the decision `NO-GO` and blocks issue #3 and all dependent implementation. Optional cuts must be named in the gate report and must not be presented as supported coverage.

## Consequences

- The repository can begin implementation only after the mandatory external probes pass in the documented WSL2/Ubuntu environment.
- The gate is reproducible through `scripts/environment_gate.py`; it emits only bounded metadata and never emits credential values or workbook contents.
- The current host's missing integrations are recorded as a no-go, not papered over with local substitutes.
- The draft ADRs remain useful historical context without competing with this decision record.
