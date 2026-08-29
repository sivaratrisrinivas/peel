import { randomUUID } from "node:crypto";

import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import type { ArtifactReference } from "../src/contracts.js";
import { FakeClock, FakeScopeAssessor, InMemoryArtifactStore, PeelDaemon } from "../src/daemon.js";
import { repairPlanHash } from "../src/identity.js";

const RECIPIENT = "recipient@example.test";
const text = new TextEncoder();

function workbook(worksheet: string, extras: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": text.encode(
      "<Types><Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/><Override PartName='/xl/workbook.xml' ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'/></Types>",
    ),
    "_rels/.rels": text.encode("<Relationships/>"),
    "xl/workbook.xml": text.encode(
      "<workbook><sheets><sheet name='Visible' sheetId='1' r:id='rId1'/></sheets></workbook>",
    ),
    "xl/_rels/workbook.xml.rels": text.encode(
      "<Relationships><Relationship Id='rId1' Target='worksheets/sheet1.xml'/></Relationships>",
    ),
    "xl/worksheets/sheet1.xml": text.encode(worksheet),
    "xl/theme/theme1.xml": text.encode("<theme><name>untouched</name></theme>"),
    ...extras,
  });
}

function concealedWorksheet(): string {
  return "<worksheet><cols><col min='3' max='3' hidden='true'/></cols><sheetData>" +
    "<row r='1'><c r='A1' s='1'><v>visible</v></c></row>" +
    "<row r='2' hidden='1'><c r='A2' t='inlineStr'><is><t>legitimate concealment</t></is></c></row>" +
    "<row r='3'><c r='A3'><v>visible</v></c><c r='C3'><v>123</v></c></row>" +
    "</sheetData></worksheet>";
}

function stageCommand(artifact: ArtifactReference, messageUid = randomUUID()) {
  return {
    version: "1" as const,
    command: "stage" as const,
    command_id: randomUUID(),
    expected_state: "new" as const,
    trigger: {
      mailbox_account: "sender@example.test",
      folder_uidvalidity: "issue-8",
      message_uid: messageUid,
      attachment_sha256: artifact.sha256,
    },
    envelope: {
      sender: "sender@example.test",
      recipient: RECIPIENT,
      subject: "Hidden values",
      body: "Intended disclosure: the visible worksheet only.",
      attachment: artifact,
    },
  };
}

function setup(bytes: Uint8Array, revealEnabled = false) {
  const clock = new FakeClock(1_700_000_000_000);
  const artifacts = new InMemoryArtifactStore(clock);
  const daemon = new PeelDaemon({
    allowedRecipients: [RECIPIENT],
    artifactStore: artifacts,
    clock,
    scopeAssessor: new FakeScopeAssessor("no_mismatch_found"),
    revealEnabled,
  });
  const artifact = artifacts.put(bytes, "hidden-values.xlsx");
  return { artifact, artifacts, bytes, clock, daemon };
}

async function scan(daemon: PeelDaemon, artifact: ArtifactReference) {
  const staged = await daemon.execute(stageCommand(artifact));
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

function applyCommand(
  run: { run_id: string; revision: number; artifact: ArtifactReference },
  approval: NonNullable<Extract<Awaited<ReturnType<PeelDaemon["execute"]>>, { ok: true }>["repair_approval"]>,
) {
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

describe("Issue #8 concealed values Attack", () => {
  it("reports hidden-row and hidden-column values independent of business legitimacy", async () => {
    const first = setup(workbook(concealedWorksheet()));
    const second = setup(workbook(concealedWorksheet().replace("legitimate concealment", "suspicious secret")));
    const firstScan = await scan(first.daemon, first.artifact);
    const secondScan = await scan(second.daemon, second.artifact);

    expect(firstScan.ok).toBe(true);
    expect(secondScan.ok).toBe(true);
    if (!firstScan.ok || !secondScan.ok) return;
    expect(firstScan.run.scan?.findings).toEqual([
      { mechanism: "hidden_row_or_column", location: "xl/worksheets", count: 2 },
    ]);
    expect(secondScan.run.scan?.findings).toEqual(firstScan.run.scan?.findings);
    expect(firstScan.run.repair_plan?.status).toBe("eligible");
    expect(JSON.stringify(firstScan)).not.toContain("legitimate concealment");
    expect(JSON.stringify(first.daemon.getRun(firstScan.run.run_id))).not.toContain("legitimate concealment");
  });

  it("keeps Reveal values on the short-lived local boundary and limits column evidence", async () => {
    const { artifact, clock, daemon } = setup(workbook(concealedWorksheet()), true);
    const result = await scan(daemon, artifact);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reveal = result.run.reveals?.[0];
    expect(reveal?.row_count).toBe(2);
    expect(JSON.stringify(result)).not.toContain("legitimate concealment");
    if (!reveal) return;
    const sample = daemon.readReveal(result.run.run_id, reveal.reference);
    expect(sample?.rows).toEqual([
      { worksheet: "Visible", row: 2, values: ["legitimate concealment"] },
      { worksheet: "Visible", row: 3, values: ["123"] },
    ]);
    expect(sample?.rows[1]?.values).not.toContain("visible");
    clock.advance(60_000);
    expect(daemon.readReveal(result.run.run_id, reveal.reference)).toBeUndefined();
  });

  it("creates one approval-bound atomic plan, clears only concealed values, and verifies fidelity", async () => {
    const base = setup(workbook(concealedWorksheet()));
    const result = await scan(base.daemon, base.artifact);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.repair_approval || !result.run.repair_plan) return;
    const plan = result.run.repair_plan;
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "clear_hidden_cell_values",
        worksheet: "Visible",
        target_member: "xl/worksheets/sheet1.xml",
        cell_references: ["A2", "C3"],
        changed_members: ["xl/worksheets/sheet1.xml"],
      }),
    ]);
    expect(plan.capability_losses.length).toBeGreaterThan(0);
    expect(result.repair_approval.binding).toEqual({
      run_id: result.run.run_id,
      revision: result.run.revision,
      original_artifact_sha256: base.artifact.sha256,
      repair_plan_sha256: repairPlanHash(plan),
      engine_version: "1.0.0",
    });

    const applied = await base.daemon.execute(applyCommand(result.run, result.repair_approval));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(base.artifacts.read(base.artifact)).toEqual(base.bytes);
    const originalFiles = unzipSync(base.bytes);
    const candidateFiles = unzipSync(base.artifacts.read(applied.run.artifact));
    const candidateSheet = new TextDecoder().decode(candidateFiles["xl/worksheets/sheet1.xml"]);
    expect(candidateSheet).not.toContain("legitimate concealment");
    expect(candidateSheet).toContain("hidden='1'");
    expect(candidateSheet).toContain("r='A1' s='1'");
    expect(candidateFiles["xl/theme/theme1.xml"]).toEqual(originalFiles["xl/theme/theme1.xml"]);
    expect(applied.run.repair?.changed_members).toEqual(["xl/worksheets/sheet1.xml"]);

    const verified = await base.daemon.execute({
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
    expect(verified.run.verification).toMatchObject({ artifact_unchanged: true, remaining_finding_count: 0 });
  });
});

describe("Issue #8 dependency refusal", () => {
  const cases = [
    ["formula", "<worksheet><sheetData><row r='2' hidden='1'><c r='A2'><v>1</v></c></row><row r='4'><c r='A4'><f>A2</f></c></row></sheetData></worksheet>", {}, "visible_formulas"],
    ["name", "<worksheet><sheetData><row r='2' hidden='1'><c r='A2'><v>1</v></c></row></sheetData></worksheet>", { "xl/workbook.xml": text.encode("<workbook><definedNames><definedName name='Secret'>Visible!A2</definedName></definedNames><sheets><sheet name='Visible' sheetId='1' r:id='rId1'/></sheets></workbook>") }, "defined_names"],
    ["validation", "<worksheet><sheetData><row r='2' hidden='1'><c r='A2'><v>1</v></c></row></sheetData><dataValidations><dataValidation><formula1>A2</formula1></dataValidation></dataValidations></worksheet>", {}, "data_validation"],
    ["table", "<worksheet><sheetData><row r='2' hidden='1'><c r='A2'><v>1</v></c></row></sheetData></worksheet>", { "xl/tables/table1.xml": text.encode("<table ref='A2:A2'/>"), "xl/worksheets/_rels/sheet1.xml.rels": text.encode("<Relationships><Relationship Id='table' Type='table' Target='../tables/table1.xml'/></Relationships>") }, "tables"],
    ["chart", "<worksheet><sheetData><row r='2' hidden='1'><c r='A2'><v>1</v></c></row></sheetData></worksheet>", { "xl/charts/chart1.xml": text.encode("<chart><f>Visible!A2</f></chart>"), "xl/worksheets/_rels/sheet1.xml.rels": text.encode("<Relationships><Relationship Id='chart' Type='chart' Target='../charts/chart1.xml'/></Relationships>") }, "charts"],
    ["pivot", "<worksheet><sheetData><row r='2' hidden='1'><c r='A2'><v>1</v></c></row></sheetData></worksheet>", { "xl/pivotTables/pivotTable1.xml": text.encode("<pivotTableDefinition><worksheetSource ref='A2:A2'/></pivotTableDefinition>"), "xl/worksheets/_rels/sheet1.xml.rels": text.encode("<Relationships><Relationship Id='pivot' Type='pivotTable' Target='../pivotTables/pivotTable1.xml'/></Relationships>") }, "pivots"],
  ] as const;

  it.each(cases)("refuses a concealed value with a %s dependency", async (_name, worksheet, extras, dependency) => {
    const base = setup(workbook(worksheet, extras));
    const result = await scan(base.daemon, base.artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("repair_refused");
    expect(result.run?.repair_plan?.dependency_analysis[dependency].length).toBeGreaterThan(0);
    expect(result.run?.repair_plan?.dependency_analysis.package_relationships.length).toBe(
      dependency === "tables" || dependency === "charts" || dependency === "pivots" ? 1 : 0,
    );
    expect(result.run?.state).toBe("refused");
  });

  it("refuses malformed worksheet XML before producing a Repair Plan", async () => {
    const base = setup(workbook("<worksheet><sheetData></worksheet>"));
    const result = await scan(base.daemon, base.artifact);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.state).toBe("refused");
    expect(result.run.scan?.status).toBe("refused");
  });
});
