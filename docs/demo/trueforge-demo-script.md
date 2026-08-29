# Peel demo recording script

This is the capture plan for the TrueForge hackathon submission. It is written
for the qualified clean-workbook journey in `docs/runbook.md`; do not add
unsupported workbook journeys to the recording.

## Recording rules

- Record from the demonstrated WSL2/Ubuntu environment only after the
  rehearsal wrapper returns `demo_ready` twice.
- Use a fresh owned test draft and owned recipient. Do not show email
  addresses, draft body text, workbook values, credentials, raw attachment
  bytes, provider transcripts, or private evidence paths.
- Keep the TrueForge UI and its approval card visible. The demo must show the
  harness doing the work: a real MCP/tool call, fresh Daytona execution, the
  approval pause, denial with zero SMTP activity, fresh approval, and exact
  recipient confirmation.
- Record the long version first. Derive the social cut from the same approved
  take so the claims and evidence stay consistent.

## YouTube version: 2:35 target, under 3:00 hard limit

| Time | Picture | Voiceover / on-screen text | Zoom cue |
| --- | --- | --- | --- |
| 0:00–0:12 | Title card, then the owned Gmail draft with the workbook values obscured | “A workbook can contain data its sender did not intend to release. Peel governs whether that attachment can leave the mailbox.” | Start at 100%; push to 112% on the title and product name. |
| 0:12–0:30 | Draft envelope: one recipient, subject, attachment name, and the visible `Intended disclosure:` label only | “Peel accepts one strict envelope, preserves the exact artifact identity, and keeps the claimed scope bound to that artifact.” | Zoom to 125% on the envelope checks; pan across the attachment/hash area. |
| 0:30–0:55 | TrueForge session and MCP/tool activity | “TrueForge is the agent harness. It reaches Peel through MCP and drives the governed workflow instead of acting as a thin chat wrapper.” | Zoom to 130% on the real tool name and returned bounded metadata. |
| 0:55–1:18 | Daytona activity and Verification result | “The workbook is inspected and verified in a fresh Daytona sandbox. The candidate is checked against the original visible baseline before release.” | Zoom to 125% on `fresh sandbox`, `Verification`, and the pass state. |
| 1:18–1:43 | Native `send_email` approval card; select denial; show resulting refused/held state and zero SMTP count | “Before anything irreversible, Peel stops. This first disclosure is denied, and the audit shows zero SMTP activity.” | Hold a 135% close-up on the approval card; quick 115% pull-back on the zero-side-effect result. |
| 1:43–2:05 | New approval card for the same verified artifact; approve through native `send_email` | “A fresh approval is required. Approval is bound to the exact Run, revision, artifact hash, recipient, and idempotency key.” | Zoom to 130% on the fresh approval identity; ease back when delivery starts. |
| 2:05–2:25 | Owned recipient mailbox showing exactly one matching message and attachment hash, with content hidden | “The owned recipient receives exactly one matching attachment. Peel confirms the hash without exposing workbook values in the evidence.” | Zoom to 128% on the matching hash and message count. |
| 2:25–2:35 | README, Qodo evidence section, and final title card | “Peel fails closed when safety cannot be proved. The repository, Qodo review trail, and qualification runbook are linked in the submission.” | 110% on the Qodo heading, then fade to the repository URL. |

## Social version: 0:30 target

| Time | Picture | Voiceover / on-screen text | Zoom cue |
| --- | --- | --- | --- |
| 0:00–0:04 | Title over the draft envelope | “What if an attachment hides data you never meant to send?” | 100% to 125% on “Peel”. |
| 0:04–0:09 | TrueForge tool call and bounded result | “Peel uses TrueForge to inspect the workbook.” | 130% on the tool call. |
| 0:09–0:14 | Daytona sandbox and Verification | “It verifies the artifact in a fresh sandbox.” | 130% on `fresh Daytona sandbox`. |
| 0:14–0:21 | Native approval card, denial, zero SMTP activity | “Before email, it stops and asks. Denied means zero side effects.” | 140% on the approval card, then snap to the zero count. |
| 0:21–0:27 | Fresh approval and recipient hash confirmation | “Approve the exact verified artifact, then confirm the matching hash.” | 130% on the fresh approval and hash. |
| 0:27–0:30 | Logo/title/URL | “Peel: govern the release, not just the reply.” | 115% title pulse, fade out. |

## Capture checklist

1. Run the two-rehearsal command from the README and retain the bounded
   `demo_ready` record outside the repository.
2. Capture the long take at 1920×1080, 30 fps, with browser/UI text large
   enough to read. Keep the cursor visible only when it explains a click.
3. Use the zoom cues as editorial direction, not as a substitute for showing
   the real approval and sandbox states.
4. Export the YouTube cut as H.264 MP4, under three minutes. Export the social
   cut as vertical 1080×1920 H.264 MP4, exactly or just under thirty seconds,
   with burned-in captions.
5. Recheck that both exports contain no secrets, addresses, workbook values,
   raw attachment bytes, or provider transcripts.

## Human-provided values still required

- YouTube URL after upload.
- Social-video URL after upload.
- Final `demo_ready` evidence path and the exact final repository commit.
- Hackathon registration/submission-form confirmation.
- Team member names and any required contact details.
- The final public repository URL, project title/tagline, and write-up text if
  the form asks for them separately from the README.

