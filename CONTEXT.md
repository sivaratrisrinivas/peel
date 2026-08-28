# Peel

Peel governs the boundary between what a sender believes an outbound file contains and what the file can actually disclose to a recipient.

## Language

**Disclosure**:
The irreversible release of an artifact to a third party.
_Avoid_: Send, email send

**Claimed Scope**:
The sender's stated boundary for the information the recipient is intended to receive, supplied by the required `Intended disclosure:` field in the draft body.
_Avoid_: Expected contents, prompt

**Attack**:
A deterministic extraction procedure that tests an artifact for a specific concealed-data mechanism.
_Avoid_: Scanner, heuristic

**Finding**:
Deterministic evidence that an Attack's concealed-data mechanism is present, regardless of whether its business content is sensitive or intended. A Finding requires review but does not by itself imply that a Repair is safe.
_Avoid_: Risk score, model opinion

**Repair**:
An approved transformation that produces a new artifact intended to remove Findings while leaving the original artifact unchanged. A Repair may be classified safe and recommended, but is never applied without Repair Approval.
_Avoid_: Cleanup, overwrite

**Verification**:
The evidence produced by rerunning the same Attacks against a repaired artifact and checking that the intended visible content remains valid.
_Avoid_: Confidence, model review

**Verification Baseline**:
A canonical snapshot of the original workbook's visible sheet order, visible cell values, formulas not approved for flattening, merged ranges, styles, and dimensions. Every difference in the repaired artifact must be an explicit consequence of the approved Repair Plan.
_Avoid_: Golden file, visual check

**Repair Approval**:
Human authorization for a proposed Repair and its stated loss of workbook capabilities, bound to one Run, original artifact hash, complete Repair Plan hash, and engine version.
_Avoid_: Approval

**Repair Plan**:
The complete atomic set of proposed Repairs and their stated capability losses for one artifact.
_Avoid_: Fix list, cleanup steps

**Disclosure Approval**:
Human authorization to release a specific verified artifact to a specific recipient with an exact sender, subject, body, attachment filename, and Run identity.
_Avoid_: Send confirmation, Approval

**Disclosure Fingerprint**:
A deterministic SHA-256 identity over the verified artifact hash, recipient, subject, and body used to reject a second successful Disclosure while allowing a fresh attempt after denial.
_Avoid_: Idempotency key, message ID

**Disclosure Attempt**:
One request to release a specific verified artifact to a specific recipient. Denial ends that attempt with zero SMTP activity; a later attempt requires a fresh Disclosure Approval and a distinct idempotency key.
_Avoid_: Retry, resend

**Mailbox Trigger**:
A deduplicated signal from the dedicated sender mailbox that identifies one draft attachment and starts a TrueForge turn. It does not inspect, repair, approve, or disclose the artifact.
_Avoid_: Mail agent, email workflow

**Artifact Reference**:
An opaque, authenticated handle plus filename, media type, and optional byte size used to move an attachment across the mailbox, orchestration, Daytona, and disclosure boundaries without treating one system's path as another system's path.
_Avoid_: File path, shared path

**Reveal Sample**:
Up to five recovered rows per Finding displayed ephemerally to the sender in TrueForge. Reveal Samples are never logged, retained in reports, copied into repaired artifacts, or included in Disclosure.
_Avoid_: Preview data, extracted dataset

**Run**:
One isolated processing attempt for a specific mailbox UID and attachment hash, from Mailbox Trigger through failure or successful Disclosure. A Run may contain multiple Disclosure Attempts, but replaying the same trigger identity must not create a second Run or duplicate a successful Disclosure Attempt.
_Avoid_: Session, job

**Refusal**:
A terminal, evidence-backed outcome in which Peel does not produce a disclosable artifact because inspection, Repair safety, or fidelity cannot be proven.
_Avoid_: Error, unsupported warning

**Demo-ready**:
The state in which the complete workflow has succeeded twice consecutively, including denied and approved Disclosure paths.
_Avoid_: Done, mostly working
