# Require an unambiguous draft envelope

The Mailbox Trigger accepts only a draft with exactly one `.xlsx` attachment, one allowlisted recipient, a non-empty subject, and one non-empty `Intended disclosure:` body field. Missing, duplicate, or ambiguous fields produce `insufficient_context` and block Repair and Disclosure. The watcher only validates and deduplicates this envelope; TrueForge remains responsible for orchestration and visible decisions.
