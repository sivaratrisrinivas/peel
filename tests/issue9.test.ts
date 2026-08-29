import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import type { ArtifactReference } from "../src/contracts.js";
import { FakeClock, FakeScopeAssessor, InMemoryArtifactStore, PeelDaemon } from "../src/daemon.js";

const text = new TextDecoder();
const encoder = new TextEncoder();
const RECIPIENT = "recipient@example.test";
const FIXTURE = new Uint8Array(readFileSync(fileURLToPath(new URL("./fixtures/pivot-cache-only.xlsx", import.meta.url))));

function setup(bytes = FIXTURE) {
  const clock = new FakeClock(1_700_000_000_000);
  const artifacts = new InMemoryArtifactStore(clock);
  const daemon = new PeelDaemon({
    allowedRecipients: [RECIPIENT],
    artifactStore: artifacts,
    clock,
    scopeAssessor: new FakeScopeAssessor("no_mismatch_found"),
    revealEnabled: true,
  });
  const artifact = artifacts.put(bytes, "pivot-cache-only.xlsx");
  return { clock, artifacts, daemon, artifact, bytes };
}

async function scanFixture(daemon: PeelDaemon, artifact: ArtifactReference) {
  const staged = await daemon.execute({
    version: "1",
    command: "stage",
    command_id: randomUUID(),
    expected_state: "new",
    trigger: {
      mailbox_account: "sender@example.test",
      folder_uidvalidity: "issue-9",
      message_uid: randomUUID(),
      attachment_sha256: artifact.sha256,
    },
    envelope: {
      sender: "sender@example.test",
      recipient: RECIPIENT,
      subject: "Pivot workbook",
      body: "Intended disclosure: the visible pivot report only.",
      attachment: artifact,
    },
  });
  expect(staged.ok).toBe(true);
  if (!staged.ok) throw new Error("stage failed");
  return daemon.execute({
    version: "1",
    command: "scan",
    command_id: randomUUID(),
    expected_state: "staged",
    run_id: staged.run.run_id,
    revision: staged.run.revision,
    artifact_sha256: artifact.sha256,
  });
}

function applyCommand(run: { run_id: string; revision: number; artifact: ArtifactReference }, approval: NonNullable<Extract<Awaited<ReturnType<PeelDaemon["execute"]>>, { ok: true }>["repair_approval"]>) {
  return {
    version: "1" as const,
    command: "apply_repair" as const,
    command_id: randomUUID(),
    expected_state: "awaiting_repair_approval" as const,
    run_id: run.run_id,
    revision: run.revision,
    artifact_sha256: run.artifact.sha256,
    approval_id: approval.approval_id,
    idempotency_key: approval.idempotency_key,
    binding: approval.binding,
  };
}

describe("Issue #9 pivot-cache disclosure journey", () => {
  it("reconstructs cache-only values through bounded Reveal and keeps them out of metadata", async () => {
    const { daemon, artifact, clock } = setup();
    const scanned = await scanFixture(daemon, artifact);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok || !scanned.repair_approval) return;

    expect(scanned.run.scan?.findings).toEqual([
      { mechanism: "pivot_cache", location: "xl/pivotCache/pivotCacheRecords1.xml", count: 4 },
    ]);
    expect(scanned.run.repair_plan?.status).toBe("eligible");
    expect(scanned.run.repair_plan?.actions[0]).toMatchObject({
      kind: "clear_pivot_cache_values",
      definition_member: "xl/pivotCache/pivotCacheDefinition1.xml",
      records_member: "xl/pivotCache/pivotCacheRecords1.xml",
    });
    expect(scanned.run.repair_plan?.capability_losses.join(" ").toLowerCase()).toContain("pivot");
    expect(JSON.stringify(scanned.run)).not.toContain("North");

    const revealReference = scanned.run.reveals?.[0];
    expect(revealReference?.row_count).toBe(4);
    if (!revealReference) return;
    expect(daemon.readReveal(scanned.run.run_id, revealReference.reference)?.rows).toEqual([
      { worksheet: "Data", row: 1, values: ["North", "Q1", "10"] },
      { worksheet: "Data", row: 2, values: ["North", "Q2", "12"] },
      { worksheet: "Data", row: 3, values: ["South", "Q1", "8"] },
      { worksheet: "Data", row: 4, values: ["South", "Q2", "13"] },
    ]);
    clock.advance(60_000);
    expect(daemon.readReveal(scanned.run.run_id, revealReference.reference)).toBeUndefined();
  });

  it("requires native Repair Approval and performs a surgical cache-only Repair", async () => {
    const { daemon, artifact, artifacts, bytes } = setup();
    const scanned = await scanFixture(daemon, artifact);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok || !scanned.repair_approval || !scanned.run.repair_plan) return;

    const applied = await daemon.execute(applyCommand(scanned.run, scanned.repair_approval));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(artifacts.read(artifact)).toEqual(bytes);
    const originalFiles = unzipSync(bytes);
    const candidateFiles = unzipSync(artifacts.read(applied.run.artifact));
    expect(applied.run.repair?.changed_members).toEqual(scanned.run.repair_plan.changed_members);
    for (const name of Object.keys(originalFiles)) {
      if (!scanned.run.repair_plan.changed_members.includes(name)) expect(candidateFiles[name]).toEqual(originalFiles[name]);
    }
    const definition = text.decode(candidateFiles["xl/pivotCache/pivotCacheDefinition1.xml"]);
    const records = text.decode(candidateFiles["xl/pivotCache/pivotCacheRecords1.xml"]);
    expect(definition).toContain('recordCount="0"');
    expect(definition).not.toMatch(/<(?:s|n|d|b|e|m)\b[^>]*>/i);
    expect(records).toContain('count="0"');
    expect(records).not.toMatch(/<r\b/i);
    expect(candidateFiles["xl/pivotTables/pivotTable1.xml"]).toEqual(originalFiles["xl/pivotTables/pivotTable1.xml"]);

    const verified = await daemon.execute({
      version: "1",
      command: "verify",
      command_id: randomUUID(),
      expected_state: "scanned",
      run_id: applied.run.run_id,
      revision: applied.run.revision,
      artifact_sha256: applied.run.artifact.sha256,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.run.state).toBe("verified");
    expect(verified.run.verification).toMatchObject({
      artifact_unchanged: true,
      remaining_finding_count: 0,
    });
  });

  it("rejects mutated approval bindings without touching the original artifact", async () => {
    const { daemon, artifact, artifacts, bytes } = setup();
    const scanned = await scanFixture(daemon, artifact);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok || !scanned.repair_approval) return;
    expect(scanned.run.state).toBe("awaiting_repair_approval");
    expect(artifacts.read(artifact)).toEqual(bytes);
    const command = applyCommand(scanned.run, scanned.repair_approval);
    const rejected = await daemon.execute({
      ...command,
      binding: { ...command.binding, repair_plan_sha256: "0".repeat(64) },
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe("repair_authorization_binding_mismatch");
    expect(artifacts.read(artifact)).toEqual(bytes);
  });

  it("refuses external pivot cache sources with a structured refusal", async () => {
    const files = unzipSync(FIXTURE);
    const definition = text.decode(files["xl/pivotCache/pivotCacheDefinition1.xml"]);
    files["xl/pivotCache/pivotCacheDefinition1.xml"] = encoder.encode(
      definition.replace('type="worksheet"', 'type="external"'),
    );
    const { daemon, artifact } = setup(zipSync(files));
    const refused = await scanFixture(daemon, artifact);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("repair_refused");
    expect(refused.run?.state).toBe("refused");
    expect(refused.run?.repair_plan?.status).toBe("refused");
    expect(refused.run?.repair_plan?.refusal_reasons?.join(" ").toLowerCase()).toContain("external");
  });
});
