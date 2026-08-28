# Peel environment gate — post-install recheck — 2026-08-28

## Decision

**NO-GO.** Installing the local prerequisites improved the optional host baseline, but the four mandatory runtime integrations are still not proven. No completion comment is authorized.

## Installed and verified

- `openpyxl 3.1.5`, `xlsxwriter 3.2.9`, and Cerebras SDK `1.91.0` import successfully under Python `3.10.12`.
- The official Daytona Linux amd64 binary is installed at `/home/srinivas/.local/bin/daytona` and reports `v0.190.0`.
- The official LibreOffice `26.8.0` Linux x86-64 bundle was downloaded, matched its published SHA-256 `d0a6031a3837e48f9854e6d2da6489b9fadbd814afa4741fa32a197741663a22`, extracted to a temporary user-local directory, and passed a headless `soffice --version` probe as `26.8.0.3`.
- The authenticated GitHub connector confirmed that `sivaratrisrinivas/peel` is public; the authenticated Gmail connector returned the owned account profile and draft metadata.

The reproducible Python package set is recorded in `requirements-gate.txt`. The temporary LibreOffice bundle is intentionally not committed to the repository.

## Mandatory gates still failing

| Gate | Result | Current evidence |
| --- | --- | --- |
| `github_qodo` | `fail` | The connector proved that the repository is public, but no pull request/Qodo review exists; the local `gh` authentication probe is also unavailable. |
| `trueforge_cerebras` | `fail` | The Cerebras SDK is importable, but no TrueForge runtime, credentials, serial tool loop, or denied native approval is available. |
| `daytona` | `fail` | CLI version works, but `daytona list --format json` with an isolated config reports no authenticated profile; no sandbox lifecycle or artifact transfer was executed. |
| `owned_mail` | `fail` | Gmail draft metadata retrieval was observed through the connector, but IMAP/SMTP configuration is absent and no owned-recipient SMTP delivery was executed. |

## Optional gates

| Gate | Result |
| --- | --- |
| Sensitive Reveal | `cut` — private transport and retention are still unproven; metadata-only policy remains. |
| LibreOffice | `pass` for this temporary user-local verification bundle. |
| Pivot fixture | `cut` — no trusted pivot workbook is present. |

The gate still exits `2` and blocks issue #3. Credentials must be configured locally and the real TrueForge/Cerebras, Daytona, Qodo, and owned-mail behaviors must be observed before issue #2 can be marked complete.
