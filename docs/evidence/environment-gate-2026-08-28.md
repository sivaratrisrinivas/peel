# Peel environment gate — 2026-08-28

## Decision

**NO-GO.** The probe exited with status `2` because four mandatory integrations were not proved. Dependent implementation must remain stopped.

## Reproduction

From the repository root:

```text
python3 scripts/environment_gate.py --format json
```

The probe records booleans, bounded identifiers, command availability, and package names only. It does not print command output, credential values, workbook values, attachment bytes, or recovered rows.

## Recorded results

| Gate | Required | Status | Evidence |
| --- | --- | --- | --- |
| `github_qodo` | Yes | `fail` | `gh` is installed, but authentication/API access failed and no Qodo review was verified. |
| `trueforge_cerebras` | Yes | `fail` | No TrueForge/Cerebras runtime adapter or configured credentials; no serial tool loop or native denial was executed. |
| `daytona` | Yes | `fail` | Daytona CLI and API credential are absent; no sandbox, transfer, execution, hash check, or destruction was observed. |
| `owned_mail` | Yes | `fail` | IMAP/SMTP configuration is absent; no owned draft retrieval or SMTP delivery was executed. |
| `reveal` | No | `cut` | Private transport and retention are unproven; no recovered values were read or recorded, and the metadata-only policy applies. |
| `libreoffice` | No | `cut` | Neither LibreOffice nor `soffice` is available. |
| `pivot_fixture` | No | `cut` | The repository has no `fixtures/` directory and no trusted pivot workbook was inspected. |
| `host_baseline` | No | `pass` | Python `3.10.12` and pytest are present; `openpyxl`, `xlsxwriter`, UNO, Node, Bun, and LibreOffice are unavailable. |

The probe also confirmed that configured credentials are represented only as presence booleans. A focused privacy test passes with sentinel values injected into the process environment.

## Test evidence

The gate's focused tests were run with pytest plugin autoload disabled because the host-wide `langsmith` pytest plugin cannot import its installed `pydantic_core` extension:

```text
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 pytest -q tests/test_environment_gate.py
3 passed
```

The plugin failure is a test-host issue, not a reason to mark any integration gate passed.

## Scope and next action

The current decision preserves the architecture in ADR-0026 and intentionally adds no production workbook, mailbox, model, or Daytona feature. Re-run the same probe after restoring GitHub authentication and provisioning the approved TrueForge/Cerebras, Daytona, and owned-mail test capabilities. Only a recorded pass for all four mandatory gates can clear issue #2 and its native blocker on issue #3.
