import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FakeClock,
  InMemoryArtifactStore,
  PeelDaemon,
} from "../src/daemon.js";
import { FakeImapMailbox, GmailImapMailbox, MailboxWatcher, type MailboxDraft } from "../src/mailbox.js";
import { MAX_ARTIFACT_BYTES, type EngineAdapter } from "../src/contracts.js";
import { envelopeRevisionHash } from "../src/identity.js";

const RECIPIENT = "recipient@example.test";
const SENDERS = "sender@example.test";
const CLEAN_BYTES = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);

const cleanEngine: EngineAdapter = {
  scan: (artifact) => ({
    version: "1",
    operation: "scan",
    status: "clean",
    artifact_sha256: artifact.sha256,
    engine_version: "1.0.0",
    supported_profile: "accepted",
    findings: [],
  }),
  verify: (artifact, originalArtifactSha256) => ({
    version: "1",
    operation: "verify",
    status: "verified",
    artifact_sha256: artifact.sha256,
    original_artifact_sha256: originalArtifactSha256,
    engine_version: "1.0.0",
    artifact_unchanged: artifact.sha256 === originalArtifactSha256,
    baseline_sha256: artifact.sha256,
    remaining_findings: [],
  }),
};

const refusingEngine: EngineAdapter = {
  scan: (artifact) => ({
    version: "1",
    operation: "scan",
    status: "refused",
    artifact_sha256: artifact.sha256,
    engine_version: "1.0.0",
    supported_profile: "refused",
    findings: [],
    refusal_code: "unsupported_container",
  }),
  verify: () => {
    throw new Error("verification is not part of this refusal test");
  },
};

function draft(overrides: Partial<MailboxDraft> = {}): MailboxDraft {
  return {
    mailbox_account: SENDERS,
    folder_uidvalidity: "uidvalidity-1",
    message_uid: "message-1",
    sender: SENDERS,
    recipients: [RECIPIENT],
    subject: "Workbook for review",
    body: "Intended disclosure: the visible workbook only.",
    attachments: [{ filename: "workbook.xlsx", bytes: CLEAN_BYTES }],
    ...overrides,
  };
}

function databasePath(): string {
  return join(tmpdir(), `peel-mailbox-${randomUUID()}.sqlite`);
}

const daemons: PeelDaemon[] = [];
const databases: string[] = [];

afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.close();
  for (const path of databases.splice(0)) {
    try {
      unlinkSync(path);
    } catch {
      // SQLite in-memory tests do not create a file.
    }
  }
});

function setup(
  initialDrafts: readonly MailboxDraft[] = [draft()],
  options: { databasePath?: string; engine?: EngineAdapter } = {},
) {
  const clock = new FakeClock(1_700_000_000_000);
  const artifacts = new InMemoryArtifactStore(clock);
  const daemon = new PeelDaemon({
    allowedRecipients: [RECIPIENT],
    artifactStore: artifacts,
    clock,
    engine: options.engine ?? cleanEngine,
    databasePath: options.databasePath,
  });
  const mailbox = new FakeImapMailbox(initialDrafts);
  const watcher = new MailboxWatcher({ daemon, mailbox, allowedRecipients: [RECIPIENT] });
  daemons.push(daemon);
  if (options.databasePath) databases.push(options.databasePath);
  return { artifacts, clock, daemon, mailbox, watcher };
}

async function reachAwaitingApproval(
  daemon: PeelDaemon,
  run: NonNullable<Awaited<ReturnType<MailboxWatcher["poll"]>>["run"]>,
) {
  const scan = await daemon.execute({
    version: "1",
    command: "scan",
    command_id: randomUUID(),
    expected_state: "staged",
    run_id: run.run_id,
    revision: run.revision,
    artifact_sha256: run.artifact.sha256,
  });
  expect(scan.ok).toBe(true);
  const verify = await daemon.execute({
    version: "1",
    command: "verify",
    command_id: randomUUID(),
    expected_state: "scanned",
    run_id: run.run_id,
    revision: run.revision,
    artifact_sha256: run.artifact.sha256,
  });
  expect(verify.ok).toBe(true);
  const requested = await daemon.execute({
    version: "1",
    command: "request_disclosure",
    command_id: randomUUID(),
    expected_state: "verified",
    run_id: run.run_id,
    revision: run.revision,
    artifact_sha256: run.artifact.sha256,
  });
  expect(requested.ok).toBe(true);
  if (!requested.ok || !requested.approval) throw new Error("approval setup failed");
  return requested.approval;
}

describe("Mailbox Trigger public boundary", () => {
  it("adapts the WSL IMAP bridge into bounded draft data", async () => {
    const mailbox = new GmailImapMailbox({
      pythonBin: "python3",
      scriptPath: "tests/fixtures/mailbox-bridge.py",
      cwd: process.cwd(),
    });

    const drafts = await mailbox.listDrafts();

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      mailbox_account: SENDERS,
      folder_uidvalidity: "uidvalidity-1",
      message_uid: "message-1",
      recipients: [RECIPIENT],
      attachments: [{ filename: "workbook.xlsx" }],
    });
    expect(drafts[0]?.attachments[0]?.bytes).toEqual(new TextEncoder().encode("xlsx"));
  });

  it("accepts one eligible draft, emits its complete identity, and deduplicates an unchanged poll", async () => {
    const { daemon, mailbox, watcher } = setup();

    const first = await watcher.poll();
    expect(first.status).toBe("triggered");
    expect(first.identity).toMatchObject({
      mailbox_account: SENDERS,
      folder_uidvalidity: "uidvalidity-1",
      message_uid: "message-1",
    });
    expect(first.identity?.attachment_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.identity?.envelope_revision_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.run?.state).toBe("staged");
    expect(first.run?.revision).toBe(1);
    expect(JSON.stringify(first)).not.toContain("visible workbook only");
    expect(JSON.stringify(first)).not.toContain("PK");
    expect(mailbox.listCalls).toHaveLength(1);

    const second = await watcher.poll();
    expect(second.status).toBe("deduplicated");
    expect(second.run?.run_id).toBe(first.run?.run_id);
    expect(daemon.getActiveRuns()).toHaveLength(1);
  });

  it("rejects a stage command whose declared envelope revision is not exact", async () => {
    const { artifacts, daemon } = setup([]);
    const artifact = artifacts.put(CLEAN_BYTES, "workbook.xlsx");
    const result = await daemon.execute({
      version: "1",
      command: "stage",
      command_id: randomUUID(),
      expected_state: "new",
      trigger: {
        mailbox_account: SENDERS,
        folder_uidvalidity: "uidvalidity-1",
        message_uid: "message-1",
        attachment_sha256: artifact.sha256,
        envelope_revision_hash: "0".repeat(64),
      },
      envelope: {
        sender: SENDERS,
        recipient: RECIPIENT,
        subject: "Workbook for review",
        body: "Intended disclosure: the visible workbook only.",
        attachment: artifact,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("trigger_identity_mismatch");
    expect(daemon.getActiveRuns()).toHaveLength(0);
  });

  it.each([
    ["multiple attachments", { attachments: [{ filename: "one.xlsx", bytes: CLEAN_BYTES }, { filename: "two.xlsx", bytes: CLEAN_BYTES }] }],
    ["wrong extension", { attachments: [{ filename: "workbook.xlsm", bytes: CLEAN_BYTES }] }],
    ["multiple recipients", { recipients: [RECIPIENT, "other@example.test"] }],
    ["recipient outside allowlist", { recipients: ["other@example.test"] }],
    ["empty subject", { subject: "   " }],
    ["missing claimed scope", { body: "A half-authored draft." }],
    ["duplicate claimed scope", { body: "Intended disclosure: one.\nIntended disclosure: two." }],
  ] as const)("does not start a Run for a %s draft", async (_name, changes) => {
    const { daemon, watcher } = setup([draft(changes)]);

    const result = await watcher.poll();

    expect(result.status).toBe("ignored");
    expect(result.error_code).toBe("ineligible_draft");
    expect(result.run).toBeUndefined();
    expect(daemon.getActiveRuns()).toHaveLength(0);
  });

  it("rejects an attachment over 10 MiB before upload", async () => {
    const { daemon, watcher } = setup([
      draft({ attachments: [{ filename: "large.xlsx", bytes: new Uint8Array(MAX_ARTIFACT_BYTES + 1) }] }),
    ]);

    const result = await watcher.poll();

    expect(result.status).toBe("ignored");
    expect(daemon.getActiveRuns()).toHaveLength(0);
  });

  it("treats an autosave envelope edit as a new revision and invalidates old approval", async () => {
    const initial = draft();
    const { daemon, mailbox, watcher } = setup([initial]);
    const first = await watcher.poll();
    expect(first.run).toBeDefined();
    if (!first.run) return;
    const approval = await reachAwaitingApproval(daemon, first.run);

    mailbox.setDrafts([draft({ body: "Intended disclosure: the revised visible workbook." })]);
    const revised = await watcher.poll();

    expect(revised.status).toBe("triggered");
    expect(revised.run?.run_id).toBe(first.run.run_id);
    expect(revised.run?.revision).toBe(2);
    expect(revised.run?.state).toBe("staged");
    expect(revised.run?.scan).toBeUndefined();
    expect(revised.run?.verification).toBeUndefined();

    const stale = await daemon.execute({
      version: "1",
      command: "respond_disclosure",
      command_id: randomUUID(),
      expected_state: "awaiting_disclosure_approval",
      run_id: first.run.run_id,
      revision: first.run.revision,
      artifact_sha256: first.run.artifact.sha256,
      approval_id: approval.approval_id,
      idempotency_key: approval.idempotency_key,
      decision: "approve",
      binding: approval.binding,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("stale_identity");
  });

  it("uses UIDVALIDITY as part of identity and starts a fresh Run after the prior one is terminal", async () => {
    const { daemon, mailbox, watcher } = setup([draft()], { engine: refusingEngine });
    const first = await watcher.poll();
    expect(first.run).toBeDefined();
    if (!first.run) return;
    const refused = await daemon.execute({
      version: "1",
      command: "scan",
      command_id: randomUUID(),
      expected_state: "staged",
      run_id: first.run.run_id,
      revision: first.run.revision,
      artifact_sha256: first.run.artifact.sha256,
    });
    expect(refused.ok).toBe(true);
    expect(daemon.getRun(first.run.run_id)?.state).toBe("refused");

    mailbox.setDrafts([draft({ folder_uidvalidity: "uidvalidity-2" })]);
    const second = await watcher.poll();

    expect(second.status).toBe("triggered");
    expect(second.run?.run_id).not.toBe(first.run.run_id);
    expect(second.identity?.folder_uidvalidity).toBe("uidvalidity-2");
  });

  it("blocks an unrelated eligible draft while one Run is active", async () => {
    const { daemon, mailbox, watcher } = setup();
    const first = await watcher.poll();
    expect(first.status).toBe("triggered");

    mailbox.setDrafts([draft({ message_uid: "message-2", subject: "Another workbook" })]);
    const blocked = await watcher.poll();

    expect(blocked.status).toBe("blocked");
    expect(blocked.error_code).toBe("active_run_exists");
    expect(blocked.run?.run_id).toBe(first.run?.run_id);
    expect(daemon.getActiveRuns()).toHaveLength(1);
  });

  it("deduplicates unchanged identity after a daemon restart", async () => {
    const path = databasePath();
    const firstSetup = setup([draft()], { databasePath: path });
    const first = await firstSetup.watcher.poll();
    expect(first.status).toBe("triggered");
    if (!first.run) return;
    firstSetup.daemon.close();
    daemons.splice(daemons.indexOf(firstSetup.daemon), 1);

    const restarted = new PeelDaemon({
      allowedRecipients: [RECIPIENT],
      artifactStore: firstSetup.artifacts,
      clock: firstSetup.clock,
      engine: cleanEngine,
      databasePath: path,
    });
    daemons.push(restarted);
    const mailbox = new FakeImapMailbox([draft()]);
    const watcher = new MailboxWatcher({ daemon: restarted, mailbox, allowedRecipients: [RECIPIENT] });
    const second = await watcher.poll();

    expect(second.status).toBe("deduplicated");
    expect(second.run?.run_id).toBe(first.run.run_id);
    expect(restarted.getActiveRuns()).toHaveLength(1);
  });

  it("serializes concurrent polls so one draft cannot create two Runs", async () => {
    const { daemon, watcher, mailbox } = setup();
    const [first, second] = await Promise.all([watcher.poll(), watcher.poll()]);

    expect(first.status).toBe("triggered");
    expect(second).toBe(first);
    expect(mailbox.listCalls).toHaveLength(1);
    expect(daemon.getActiveRuns()).toHaveLength(1);
  });

  it("keeps manual staging available when the optional watcher is not used", async () => {
    const { artifacts, daemon } = setup([]);
    const artifact = artifacts.put(CLEAN_BYTES, "manual.xlsx");
    const result = await daemon.execute({
      version: "1",
      command: "stage",
      command_id: randomUUID(),
      expected_state: "new",
      trigger: {
        mailbox_account: SENDERS,
        folder_uidvalidity: "manual-folder",
        message_uid: "manual-message",
        attachment_sha256: artifact.sha256,
      },
      envelope: {
        sender: SENDERS,
        recipient: RECIPIENT,
        subject: "Manual fallback",
        body: "Intended disclosure: the visible workbook.",
        attachment: artifact,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.run.state).toBe("staged");
  });

  it("computes the revision identity over the complete normalized envelope", async () => {
    const candidate = draft();
    const { watcher } = setup([candidate]);
    const result = await watcher.poll();

    expect(result.identity).toBeDefined();
    if (!result.identity) return;
    const digest = result.identity.attachment_sha256;
    expect(result.identity.envelope_revision_hash).toBe(
      envelopeRevisionHash({
        sender: candidate.sender,
        recipient: RECIPIENT,
        subject: candidate.subject,
        body: candidate.body,
        attachment: {
          reference: `peel-artifact-${"0".repeat(22)}`,
          filename: candidate.attachments[0]!.filename,
          media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          byte_size: candidate.attachments[0]!.bytes.byteLength,
          sha256: digest,
        },
      }),
    );
  });
});
