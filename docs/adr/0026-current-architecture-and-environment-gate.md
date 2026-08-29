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

The TrueForge/Cerebras gate uses an explicitly configured Cerebras custom model and records the model resolved by the returned TrueForge session and live model/provider catalogs. `gpt-oss-120b` remains the preferred model; the current TrueForge 0.1.4 runtime probe also supports the configured `gemma-4-31b` fallback because the preferred model's deferred-tool continuation returned HTTP 400. Selecting the fallback is valid only after the same serial-tool, native-denial, runtime-identity, and zero-side-effect proof passes; it is not a silent provider substitution.

Google Drive is an optional fixture-intake and review path for the hackathon. It may provide a sanitized raw `.xlsx` fixture or a metadata-only report, but it does not own Run state, approvals, artifact identity, formula evaluation, or fidelity decisions. Peel must fetch the original Office file, verify its hash locally, and avoid converting the authoritative fixture into native Google Sheets. The public OOXML reference corpus now supplies the pivot authoring source package; issue #9 derives a cache-only variant by removing only the visible source worksheet and its package references. The source and derived hashes are recorded in `docs/evidence/pivot-cache-fixture-2026-08-29.md`.

The supported claim is limited to mechanisms that Peel supports and successfully executes. Unknown or unsupported content-bearing workbook features, unproven fidelity, or failed Verification produce Refusal rather than a globally “clean” result. Untouched OOXML ZIP members remain byte-identical; changed members receive targeted semantic checks.

## Environment gate

The gate is a prerequisite for dependent implementation. A mandatory gate passes only after its live behavior is observed and recorded; configuration presence alone is not proof.

| Gate | Required evidence | Current result |
| --- | --- | --- |
| GitHub and Qodo | Public repository access and a Qodo review publication on the repository | Pass — public access, the configured target PR at the current checkout commit, and the final exact-commit Qodo Code Review publication with all findings resolved were verified; clean comment updates are valid when no new GitHub review object is emitted |
| TrueForge and Cerebras | Serial tool loop with a configured Cerebras model, native approval denial, and zero side effects | Pass — the returned runtime identity and `gemma-4-31b` live TrueForge probe passed; `gpt-oss-120b` remains the preferred recheck target after the TrueForge runtime compatibility issue is resolved |
| Daytona | Fresh sandbox, upload, declared command, hash-verified download, and destruction | Pass — the live Python SDK probe completed the full lifecycle and hash check |
| Owned mail | Owned Gmail draft retrieval and owned-recipient SMTP delivery | Pass — the live IMAP/SMTP probe validated the strict draft envelope and completed one owned-recipient delivery |
| Sensitive Reveal | Private transcript/retention path | Cut — metadata-only policy applies until proven |
| LibreOffice | Availability for supported-profile reopen checks | Cut — the current host has no available LibreOffice binary; the dependent route remains out of scope |
| Pivot fixture | Inspected trusted package with the required pivot-cache structures | Pass — public OOXML source and derived cache-only fixture contain the definition, records, populated shared items, and a cache-only value |

The final consolidated decision is `GO`: every mandatory gate passed in the live environment record dated 2026-08-28. Any future mandatory failure keeps the decision `NO-GO` and blocks issue #3 and all dependent implementation. Optional cuts must be named in the gate report and must not be presented as supported coverage.

## Consequences

- The repository can begin implementation only after the mandatory external probes pass in the documented WSL2/Ubuntu environment.
- The gate is reproducible through `scripts/environment_gate.py`; it emits only bounded metadata and never emits credential values or workbook contents.
- The currently unavailable optional integrations are recorded as explicit cuts, not papered over with local substitutes.
- The draft ADRs remain useful historical context without competing with this decision record.
