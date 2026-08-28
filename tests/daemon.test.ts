import { randomUUID } from "node:crypto";

import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  FakeClock,
  FakeDisclosureMailer,
  InMemoryArtifactStore,
  PeelDaemon,
} from "../src/daemon.js";

const RECIPIENT = "recipient@example.test";

function cleanWorkbook(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8"?>
       <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
         <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
         <Default Extension="xml" ContentType="application/xml"/>
         <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
         <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
       </Types>`,
    ),
    "_rels/.rels": new TextEncoder().encode("<Relationships/>"),
    "xl/workbook.xml": new TextEncoder().encode(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Visible" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/worksheets/sheet1.xml": new TextEncoder().encode(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
    ),
  });
}

function setup() {
  const clock = new FakeClock(1_700_000_000_000);
  const artifacts = new InMemoryArtifactStore(clock);
  const mailer = new FakeDisclosureMailer();
  const daemon = new PeelDaemon({
    allowedRecipients: [RECIPIENT],
    artifactStore: artifacts,
    clock,
    disclosureMailer: mailer,
  });
  const bytes = cleanWorkbook();
  const artifact = artifacts.put(bytes, "clean.xlsx");
  return { artifact, artifacts, bytes, clock, daemon, mailer };
}

function stageCommand(
  artifact: ReturnType<InMemoryArtifactStore["put"]>,
  body = "Intended disclosure: the visible workbook.",
  subject = "Clean workbook",
) {
  return {
    version: "1",
    command: "stage",
    command_id: randomUUID(),
    expected_state: "new",
    trigger: {
      mailbox_account: "sender@example.test",
      folder_uidvalidity: "uidvalidity-1",
      message_uid: "message-1",
      attachment_sha256: artifact.sha256,
    },
    envelope: {
      sender: "sender@example.test",
      recipient: RECIPIENT,
      subject,
      body,
      attachment: artifact,
    },
  };
}

describe("Peel public daemon boundary", () => {
  it("governs a clean workbook through denied and fresh approved Disclosure", async () => {
    const { artifact, bytes, daemon, mailer } = setup();

    const staged = await daemon.execute(stageCommand(artifact));
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    const runId = staged.run.run_id;
    const revision = staged.run.revision;
    const scanned = await daemon.execute({
      version: "1",
      command: "scan",
      command_id: randomUUID(),
      expected_state: "staged",
      run_id: runId,
      revision,
      artifact_sha256: artifact.sha256,
    });
    expect(scanned.ok).toBe(true);

    const verified = await daemon.execute({
      version: "1",
      command: "verify",
      command_id: randomUUID(),
      expected_state: "scanned",
      run_id: runId,
      revision,
      artifact_sha256: artifact.sha256,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.run.state).toBe("verified");
    expect(verified.run.verification?.artifact_unchanged).toBe(true);

    const requested = await daemon.execute({
      version: "1",
      command: "request_disclosure",
      command_id: randomUUID(),
      expected_state: "verified",
      run_id: runId,
      revision,
      artifact_sha256: artifact.sha256,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.approval) return;

    const denied = await daemon.execute({
      version: "1",
      command: "respond_disclosure",
      command_id: randomUUID(),
      expected_state: "awaiting_disclosure_approval",
      run_id: runId,
      revision,
      artifact_sha256: artifact.sha256,
      approval_id: requested.approval.approval_id,
      idempotency_key: requested.approval.idempotency_key,
      decision: "deny",
      binding: requested.approval.binding,
    });
    expect(denied.ok).toBe(true);
    expect(mailer.calls).toHaveLength(0);

    const freshRequest = await daemon.execute({
      version: "1",
      command: "request_disclosure",
      command_id: randomUUID(),
      expected_state: "verified",
      run_id: runId,
      revision,
      artifact_sha256: artifact.sha256,
    });
    expect(freshRequest.ok).toBe(true);
    if (!freshRequest.ok || !freshRequest.approval) return;

    const approved = await daemon.execute({
      version: "1",
      command: "respond_disclosure",
      command_id: randomUUID(),
      expected_state: "awaiting_disclosure_approval",
      run_id: runId,
      revision,
      artifact_sha256: artifact.sha256,
      approval_id: freshRequest.approval.approval_id,
      idempotency_key: freshRequest.approval.idempotency_key,
      decision: "approve",
      binding: freshRequest.approval.binding,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.run.state).toBe("disclosed");
    expect(mailer.calls).toHaveLength(1);
    expect(mailer.calls[0]?.bytes).toEqual(bytes);
    expect(mailer.calls[0]?.recipient).toBe(RECIPIENT);

    const duplicate = await daemon.execute({
      version: "1",
      command: "respond_disclosure",
      command_id: randomUUID(),
      expected_state: "awaiting_disclosure_approval",
      run_id: runId,
      revision,
      artifact_sha256: artifact.sha256,
      approval_id: freshRequest.approval.approval_id,
      idempotency_key: freshRequest.approval.idempotency_key,
      decision: "approve",
      binding: freshRequest.approval.binding,
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("duplicate_disclosure");
    expect(mailer.calls).toHaveLength(1);
  });
});

async function reachVerified(
  daemon: PeelDaemon,
  artifact: ReturnType<InMemoryArtifactStore["put"]>,
  body?: string,
) {
  const staged = await daemon.execute(stageCommand(artifact, body));
  expect(staged.ok).toBe(true);
  if (!staged.ok) throw new Error("stage failed in test setup");
  const scanned = await daemon.execute({
    version: "1",
    command: "scan",
    command_id: randomUUID(),
    expected_state: "staged",
    run_id: staged.run.run_id,
    revision: staged.run.revision,
    artifact_sha256: artifact.sha256,
  });
  expect(scanned.ok).toBe(true);
  const verified = await daemon.execute({
    version: "1",
    command: "verify",
    command_id: randomUUID(),
    expected_state: "scanned",
    run_id: staged.run.run_id,
    revision: staged.run.revision,
    artifact_sha256: artifact.sha256,
  });
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error("verify failed in test setup");
  return verified.run;
}

describe("Peel safety boundaries", () => {
  it("invalidates prior evidence and Disclosure Approval when the envelope revision changes", async () => {
    const { artifact, daemon, mailer } = setup();
    const verified = await reachVerified(daemon, artifact);
    const requested = await daemon.execute({
      version: "1",
      command: "request_disclosure",
      command_id: randomUUID(),
      expected_state: "verified",
      run_id: verified.run_id,
      revision: verified.revision,
      artifact_sha256: artifact.sha256,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.approval) return;

    const revised = await daemon.execute(stageCommand(artifact, "Intended disclosure: a changed scope.", "Changed workbook"));
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.run.revision).toBe(2);
    expect(revised.run.state).toBe("staged");
    expect(revised.run.scan).toBeUndefined();
    expect(revised.run.verification).toBeUndefined();

    const staleApproval = await daemon.execute({
      version: "1",
      command: "respond_disclosure",
      command_id: randomUUID(),
      expected_state: "awaiting_disclosure_approval",
      run_id: verified.run_id,
      revision: verified.revision,
      artifact_sha256: artifact.sha256,
      approval_id: requested.approval.approval_id,
      idempotency_key: requested.approval.idempotency_key,
      decision: "approve",
      binding: requested.approval.binding,
    });
    expect(staleApproval.ok).toBe(false);
    if (staleApproval.ok) return;
    expect(staleApproval.error.code).toBe("stale_identity");
    expect(mailer.calls).toHaveLength(0);
  });

  it("rejects unknown command fields and stale state at the public boundary", async () => {
    const { artifact, daemon } = setup();
    const staged = await daemon.execute({ ...stageCommand(artifact), unexpected: true });
    expect(staged.ok).toBe(false);
    if (staged.ok) return;
    expect(staged.error.code).toBe("invalid_schema");

    const realStage = await daemon.execute(stageCommand(artifact));
    expect(realStage.ok).toBe(true);
    if (!realStage.ok) return;
    const duplicateStage = await daemon.execute(stageCommand(artifact));
    expect(duplicateStage.ok).toBe(true);
    if (!duplicateStage.ok) return;
    expect(duplicateStage.deduplicated).toBe(true);
    expect(duplicateStage.run.run_id).toBe(realStage.run.run_id);
    const firstScan = await daemon.execute({
      version: "1",
      command: "scan",
      command_id: randomUUID(),
      expected_state: "staged",
      run_id: realStage.run.run_id,
      revision: realStage.run.revision,
      artifact_sha256: artifact.sha256,
    });
    expect(firstScan.ok).toBe(true);
    const repeatedScan = await daemon.execute({
      version: "1",
      command: "scan",
      command_id: randomUUID(),
      expected_state: "staged",
      run_id: realStage.run.run_id,
      revision: realStage.run.revision,
      artifact_sha256: artifact.sha256,
    });
    expect(repeatedScan.ok).toBe(false);
    if (repeatedScan.ok) return;
    expect(repeatedScan.error.code).toBe("stale_state");
  });

  it("refuses an unprovable workbook container before any Disclosure", async () => {
    const { clock, daemon, mailer, artifacts } = setup();
    const artifact = artifacts.put(new TextEncoder().encode("not an Office package"), "unknown.xlsx");
    const staged = await daemon.execute(stageCommand(artifact));
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const scanned = await daemon.execute({
      version: "1",
      command: "scan",
      command_id: randomUUID(),
      expected_state: "staged",
      run_id: staged.run.run_id,
      revision: staged.run.revision,
      artifact_sha256: artifact.sha256,
    });
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.run.state).toBe("refused");
    expect(scanned.run.scan?.supported_profile).toBe("refused");
    expect(mailer.calls).toHaveLength(0);
    clock.advance(1);
  });

  it("fails closed when an Artifact Reference expires or its bytes change", async () => {
    const expired = setup();
    const expiredArtifact = expired.artifacts.put(expired.bytes, "expired.xlsx", 100);
    const stagedExpired = await expired.daemon.execute(stageCommand(expiredArtifact));
    expect(stagedExpired.ok).toBe(true);
    if (!stagedExpired.ok) return;
    expired.clock.advance(100);
    const expiredScan = await expired.daemon.execute({
      version: "1",
      command: "scan",
      command_id: randomUUID(),
      expected_state: "staged",
      run_id: stagedExpired.run.run_id,
      revision: stagedExpired.run.revision,
      artifact_sha256: expiredArtifact.sha256,
    });
    expect(expiredScan.ok).toBe(false);
    if (expiredScan.ok) return;
    expect(expiredScan.error.code).toBe("artifact_expired");

    const corrupted = setup();
    const corruptedArtifact = corrupted.artifacts.put(corrupted.bytes, "corrupted.xlsx");
    const stagedCorrupted = await corrupted.daemon.execute(stageCommand(corruptedArtifact));
    expect(stagedCorrupted.ok).toBe(true);
    if (!stagedCorrupted.ok) return;
    corrupted.artifacts.corrupt(corruptedArtifact);
    const corruptedScan = await corrupted.daemon.execute({
      version: "1",
      command: "scan",
      command_id: randomUUID(),
      expected_state: "staged",
      run_id: stagedCorrupted.run.run_id,
      revision: stagedCorrupted.run.revision,
      artifact_sha256: corruptedArtifact.sha256,
    });
    expect(corruptedScan.ok).toBe(false);
    if (corruptedScan.ok) return;
    expect(corruptedScan.error.code).toBe("artifact_integrity_failure");
  });

  it("expires Disclosure Approval and never retries ambiguous delivery", async () => {
    const expired = setup();
    const verified = await reachVerified(expired.daemon, expired.artifact);
    const requested = await expired.daemon.execute({
      version: "1",
      command: "request_disclosure",
      command_id: randomUUID(),
      expected_state: "verified",
      run_id: verified.run_id,
      revision: verified.revision,
      artifact_sha256: expired.artifact.sha256,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.approval) return;
    expired.clock.advance(5 * 60 * 1000);
    const late = await expired.daemon.execute({
      version: "1",
      command: "respond_disclosure",
      command_id: randomUUID(),
      expected_state: "awaiting_disclosure_approval",
      run_id: verified.run_id,
      revision: verified.revision,
      artifact_sha256: expired.artifact.sha256,
      approval_id: requested.approval.approval_id,
      idempotency_key: requested.approval.idempotency_key,
      decision: "approve",
      binding: requested.approval.binding,
    });
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.error.code).toBe("authorization_expired");
    expect(expired.mailer.calls).toHaveLength(0);

    const ambiguous = setup();
    const ambiguousVerified = await reachVerified(ambiguous.daemon, ambiguous.artifact);
    const ambiguousRequest = await ambiguous.daemon.execute({
      version: "1",
      command: "request_disclosure",
      command_id: randomUUID(),
      expected_state: "verified",
      run_id: ambiguousVerified.run_id,
      revision: ambiguousVerified.revision,
      artifact_sha256: ambiguous.artifact.sha256,
    });
    expect(ambiguousRequest.ok).toBe(true);
    if (!ambiguousRequest.ok || !ambiguousRequest.approval) return;
    ambiguous.mailer.nextOutcome = "ambiguous";
    const attempt = {
      version: "1",
      command: "respond_disclosure" as const,
      command_id: randomUUID(),
      expected_state: "awaiting_disclosure_approval" as const,
      run_id: ambiguousVerified.run_id,
      revision: ambiguousVerified.revision,
      artifact_sha256: ambiguous.artifact.sha256,
      approval_id: ambiguousRequest.approval.approval_id,
      idempotency_key: ambiguousRequest.approval.idempotency_key,
      decision: "approve" as const,
      binding: ambiguousRequest.approval.binding,
    };
    const uncertain = await ambiguous.daemon.execute(attempt);
    expect(uncertain.ok).toBe(false);
    if (uncertain.ok) return;
    expect(uncertain.error.code).toBe("delivery_unknown");
    expect(uncertain.run?.state).toBe("delivery_unknown");
    expect(ambiguous.mailer.calls).toHaveLength(1);
    const replay = await ambiguous.daemon.execute(attempt);
    expect(replay.ok).toBe(false);
    expect(ambiguous.mailer.calls).toHaveLength(1);
  });
});
