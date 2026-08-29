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

function zipFixture(files: Record<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  const bytes = zipSync(files);
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

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

function visibleSourceWithPrefixedRelationships(): Uint8Array<ArrayBuffer> {
  const files = unzipSync(FIXTURE);
  const workbook = text.decode(files["xl/workbook.xml"]!);
  files["xl/workbook.xml"] = encoder.encode(
    workbook
      .replace('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"', 'xmlns:x="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
      .replaceAll("r:id=", "x:id=")
      .replace('name="Report"', 'name="Data"'),
  );
  files["xl/worksheets/sheet2.xml"] = encoder.encode(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="str"><v>North</v></c><c r="B1" t="str"><v>Q1</v></c><c r="C1"><v>10</v></c></row>' +
      '<row r="2"><c r="A2" t="str"><v>North</v></c><c r="B2" t="str"><v>Q2</v></c><c r="C2"><v>12</v></c></row>' +
      '<row r="3"><c r="A3" t="str"><v>South</v></c><c r="B3" t="str"><v>Q1</v></c><c r="C3"><v>8</v></c></row>' +
      '<row r="4"><c r="A4" t="str"><v>South</v></c><c r="B4" t="str"><v>Q2</v></c><c r="C4"><v>13</v></c></row>' +
      '</sheetData></worksheet>',
  );
  return zipFixture(files);
}

function missingRecordsRelationshipFixture(): Uint8Array<ArrayBuffer> {
  const files = unzipSync(FIXTURE);
  files["xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels"] = encoder.encode(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
  );
  return zipFixture(files);
}

function mixedFieldFixture(): Uint8Array<ArrayBuffer> {
  const files = unzipSync(FIXTURE);
  const definition = text.decode(files["xl/pivotCache/pivotCacheDefinition1.xml"]!);
  files["xl/pivotCache/pivotCacheDefinition1.xml"] = encoder.encode(
    definition.replace(
      /<cacheFields[\s\S]*?<\/cacheFields>/,
      '<cacheFields count="3"><cacheField name="Sales"><sharedItems count="0"/></cacheField>' +
        '<cacheField name="Region"><sharedItems count="2"><s v="North"/><s v="South"/></sharedItems></cacheField>' +
        '<cacheField name="Quarter"><sharedItems count="2"><s v="Q1"/><s v="Q2"/></sharedItems></cacheField></cacheFields>',
    ),
  );
  files["xl/pivotCache/pivotCacheRecords1.xml"] = encoder.encode(
    '<pivotCacheRecords count="4" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<r><n v="10"/><x v="0"/><x v="0"/></r><r><n v="12"/><x v="0"/><x v="1"/></r>' +
      '<r><n v="8"/><x v="1"/><x v="0"/></r><r><n v="13"/><x v="1"/><x v="1"/></r></pivotCacheRecords>',
  );
  return zipFixture(files);
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
    expect(definition).not.toContain("</sharedItems>");
    expect(records).toContain('count="0"');
    expect(records).not.toMatch(/<r\b/i);
    expect(records).not.toMatch(/<(?:x|s|n|d|b|e|m)\b/i);
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
    const { daemon, artifact } = setup(zipFixture(files));
    const refused = await scanFixture(daemon, artifact);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("repair_refused");
    expect(refused.run?.state).toBe("refused");
    expect(refused.run?.repair_plan?.status).toBe("refused");
    expect(refused.run?.repair_plan?.refusal_reasons?.join(" ").toLowerCase()).toContain("external");
  });

  it("does not report a pivot cache when every reconstructed value is visible", async () => {
    const { daemon, artifact } = setup(visibleSourceWithPrefixedRelationships());
    const scanned = await scanFixture(daemon, artifact);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.run.scan?.findings).toEqual([]);
    expect(scanned.run.repair_plan).toBeUndefined();
  });

  it("keeps one shared-item slot for an empty field before populated fields", async () => {
    const { daemon, artifact } = setup(mixedFieldFixture());
    const scanned = await scanFixture(daemon, artifact);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok || !scanned.run.reveals?.[0]) return;
    expect(daemon.readReveal(scanned.run.run_id, scanned.run.reveals[0].reference)?.rows[0]).toEqual({
      worksheet: "Data",
      row: 1,
      values: ["10", "North", "Q1"],
    });
  });

  it("uses the definition member as a stable location when records are unavailable", async () => {
    const { daemon, artifact } = setup(missingRecordsRelationshipFixture());
    const refused = await scanFixture(daemon, artifact);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("repair_refused");
    expect(refused.run?.scan?.findings).toEqual([
      { mechanism: "pivot_cache", location: "xl/pivotCache/pivotCacheDefinition1.xml", count: 1 },
    ]);
    expect(refused.run?.repair_plan?.status).toBe("refused");
  });
});
