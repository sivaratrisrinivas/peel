# Bind approvals to immutable content identities

Repair Approval is bound to the Run ID, original workbook SHA-256, canonical Repair Plan SHA-256, and engine version. Disclosure Approval presents and binds the exact verified artifact hash, recipient, sender, subject, body, attachment filename, and Run ID. Changing any bound input invalidates approval. The MVP keeps only four content identities: original workbook SHA-256, repaired workbook SHA-256, canonical Repair Plan SHA-256, and the Disclosure Fingerprint. Peel does not add per-row hashes, signatures, a hash chain, or a general-purpose cryptographic ledger.

Each Disclosure Attempt receives a random idempotency key that is reused only for retries of that attempt. A separate Disclosure Fingerprint prevents a second successful send of the same verified artifact, recipient, subject, and body, while a denied attempt records no success and therefore permits a fresh approved attempt.
