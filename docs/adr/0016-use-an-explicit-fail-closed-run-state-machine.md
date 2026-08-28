# Use an explicit fail-closed Run state machine

A Run advances through `triggered`, `staged`, `scanned`, `awaiting_repair_approval`, `repairing`, `verifying`, `verified`, `awaiting_disclosure_approval`, and `disclosed`, with terminal `refused` and `failed` outcomes. Completed deterministic evidence may survive restart, but pending approvals are canceled and Repair or Disclosure side effects never resume automatically. Repair Approval expires after ten minutes and Disclosure Approval after five; restart, mutation of a bound field, or loss of the staged artifact invalidates either approval.
