import { randomUUID } from "node:crypto";

import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import type { ArtifactReference, EngineAdapter, EngineRepairResult, RepairPlan } from "../src/contracts.js";
import { FakeClock, FakeScopeAssessor, InMemoryArtifactStore, PeelDaemon } from "../src/daemon.js";
import { FakeWorkbookEngine } from "../src/adapters.js";
import { createPeelHttpServer } from "../src/http.js";
import { repairPlanHash } from "../src/identity.js";

const RECIPIENT = "recipient@example.test";
const text = new TextEncoder();

function workbook(hiddenSheetXml = "<sheetData/>", extras: Record<string, Uint8Array> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": text.encode(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": text.encode("<Relationships/>"),
    "xl/workbook.xml": text.encode(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Visible" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="veryHidden" r:id="rId2"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": text.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": text.encode(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
    ),
    "xl/worksheets/sheet2.xml": text.encode(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${hiddenSheetXml}</worksheet>`,
    ),
    "xl/theme/theme1.xml": text.encode("<theme><name>untouched</name></theme>"),
    ...extras,
  };
  return zipSync(files);
}

function stageCommand(artifact: ArtifactReference, messageUid = randomUUID(), body = "Intended disclosure: the visible worksheet only.") {
  return {
    version: "1" as const,
    command: "stage" as const,
    command_id: randomUUID(),
    expected_state: "new" as const,
    trigger: {
      mailbox_account: "sender@example.test",
      folder_uidvalidity: "issue-6",
      message_uid: messageUid,
      attachment_sha256: artifact.sha256,
    },
    envelope: {
      sender: "sender@example.test",
      recipient: RECIPIENT,
      subject: "Hidden workbook",
      body,
      attachment: artifact,
    },
  };
}

function setup(bytes = workbook()) {
  const clock = new FakeClock(1_700_000_000_000);
  const artifacts = new InMemoryArtifactStore(clock);
  const daemon = new PeelDaemon({
    allowedRecipients: [RECIPIENT],
    artifactStore: artifacts,
    clock,
    scopeAssessor: new FakeScopeAssessor("no_mismatch_found"),
  });
  const artifact = artifacts.put(bytes, "hidden.xlsx");
  return { artifact, artifacts, bytes, clock, daemon };
}

async function scanForRepair(daemon: PeelDaemon, artifact: ArtifactReference, messageUid = randomUUID()) {
  const staged = await daemon.execute(stageCommand(artifact, messageUid));
  expect(staged.ok).toBe(true);
  if (!staged.ok) throw new Error("stage failed");
  const scanned = await daemon.execute({
    version: "1",
    command: "scan",
    command_id: randomUUID(),
    expected_state: "staged",
    run_id: staged.run.run_id,
    revision: staged.run.revision,
    artifact_sha256: artifact.sha256,
  });
  return { staged: staged.run, scanned };
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

describe("Issue #6 hidden worksheet Repair journey", () => {
  it("creates one complete dependency-aware Repair Plan and applies it only after native approval", async () => {
    const { artifact, artifacts, bytes, daemon } = setup(workbook('<sheetData><row r="1"><c r="A1"><v>secret</v></c></row></sheetData>'));
    const { scanned } = await scanForRepair(daemon, artifact);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok || !scanned.repair_approval) return;
    const plan = scanned.run.repair_plan;
    expect(plan?.status).toBe("eligible");
    expect(plan?.actions).toHaveLength(1);
    expect(plan?.capability_losses.length).toBeGreaterThan(0);
    expect(plan?.dependency_analysis).toEqual({
      visible_formulas: [],
      defined_names: [],
      data_validation: [],
      tables: [],
      charts: [],
      pivots: [],
      package_relationships: [],
      macros: [],
      external_connections: [],
    });
    expect(scanned.run.state).toBe("awaiting_repair_approval");
    expect(scanned.repair_approval.binding).toEqual({
      run_id: scanned.run.run_id,
      revision: scanned.run.revision,
      original_artifact_sha256: artifact.sha256,
      repair_plan_sha256: plan ? repairPlanHash(plan) : "",
      engine_version: "1.0.0",
    });

    const server = createPeelHttpServer(daemon);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server did not bind a port");
    let applied: Awaited<ReturnType<PeelDaemon["execute"]>>;
    try {
      const command = applyCommand(scanned.run, scanned.repair_approval);
      const listResponse = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
      });
      const listed = (await listResponse.json()) as { result: { tools: Array<{ name: string }> } };
      expect(listed.result.tools.map((tool) => tool.name)).toContain("apply_repair");
      const nativeResponse = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "apply_repair", arguments: { ...command, command: undefined } },
        }),
      });
      const native = (await nativeResponse.json()) as { result: { content: Array<{ text: string }> } };
      applied = JSON.parse(native.result.content[0]!.text) as Awaited<ReturnType<PeelDaemon["execute"]>>;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.run.state).toBe("scanned");
    expect(applied.run.original_artifact.sha256).toBe(artifact.sha256);
    expect(applied.run.artifact.sha256).not.toBe(artifact.sha256);
    expect(artifacts.read(artifact)).toEqual(bytes);
    const originalFiles = unzipSync(bytes);
    const candidateFiles = unzipSync(artifacts.read(applied.run.artifact));
    expect(candidateFiles["xl/worksheets/sheet2.xml"]).toBeUndefined();
    for (const name of Object.keys(originalFiles)) {
      if (!plan?.changed_members.includes(name)) expect(candidateFiles[name]).toEqual(originalFiles[name]);
    }
    expect(applied.run.repair?.changed_members).toEqual(plan?.changed_members);

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
    const disclosure = await daemon.execute({
      version: "1",
      command: "request_disclosure",
      command_id: randomUUID(),
      expected_state: "verified",
      run_id: verified.run.run_id,
      revision: verified.run.revision,
      artifact_sha256: verified.run.artifact.sha256,
    });
    expect(disclosure.ok).toBe(true);
  });

  it("records every declared dependency capability and refuses unsafe Repair", async () => {
    const rich = workbook(
      `<sheetData><row r="1"><c r="A1"><f>'Hidden'!A1</f><v>1</v></c></row></sheetData><dataValidations><dataValidation><formula1>'Hidden'!$A$1</formula1></dataValidation></dataValidations>`,
      {
        "xl/workbook.xml": text.encode(
          `<workbook><definedNames><definedName name="HiddenValue">Hidden!$A$1</definedName></definedNames><sheets><sheet name="Visible" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
        ),
        "xl/worksheets/sheet1.xml": text.encode(
          `<worksheet><sheetData><row><c><f>Hidden!$A$1</f></c></row></sheetData><dataValidations><dataValidation><formula1>Hidden!$A$1</formula1></dataValidation></dataValidations></worksheet>`,
        ),
        "xl/tables/table1.xml": text.encode(`<table ref="Hidden!A1"/>`),
        "xl/charts/chart1.xml": text.encode(`<chart><f>Hidden!$A$1</f></chart>`),
        "xl/pivotTables/pivotTable1.xml": text.encode(`<pivotTableDefinition><location ref="Hidden!A1"/></pivotTableDefinition>`),
        "xl/worksheets/_rels/sheet1.xml.rels": text.encode(`<Relationships><Relationship Id="rIdHidden" Target="sheet2.xml"/></Relationships>`),
        "xl/vbaProject.bin": new Uint8Array([1, 2, 3]),
        "xl/connections.xml": text.encode("<connections/>")
      },
    );
    const { artifact, daemon } = setup(rich);
    const { scanned } = await scanForRepair(daemon, artifact);
    expect(scanned.ok).toBe(false);
    if (scanned.ok) return;
    expect(scanned.error.code).toBe("repair_refused");
    const analysis = scanned.run?.repair_plan?.dependency_analysis;
    expect(analysis?.visible_formulas.length).toBeGreaterThan(0);
    expect(analysis?.defined_names.length).toBeGreaterThan(0);
    expect(analysis?.data_validation.length).toBeGreaterThan(0);
    expect(analysis?.tables.length).toBeGreaterThan(0);
    expect(analysis?.charts.length).toBeGreaterThan(0);
    expect(analysis?.pivots.length).toBeGreaterThan(0);
    expect(analysis?.package_relationships.length).toBeGreaterThan(0);
    expect(analysis?.macros.length).toBeGreaterThan(0);
    expect(analysis?.external_connections.length).toBeGreaterThan(0);
    expect(scanned.run?.repair_plan?.capability_losses.length).toBeGreaterThan(0);
    expect(scanned.run?.repair_plan?.refusal_reasons?.length).toBeGreaterThan(0);
    expect(scanned.run?.state).toBe("refused");
  });

  it("performs no Repair for denial, expiry, restart, replay, or envelope mutation", async () => {
    const first = setup();
    const { scanned } = await scanForRepair(first.daemon, first.artifact);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok || !scanned.repair_approval) return;
    const original = first.artifacts.read(first.artifact);
    // A denied native approval means apply_repair is never invoked.
    expect(first.daemon.getRun(scanned.run.run_id)?.state).toBe("awaiting_repair_approval");
    expect(first.artifacts.read(first.artifact)).toEqual(original);

    const tamperedBinding = {
      ...scanned.repair_approval.binding,
      repair_plan_sha256: "0".repeat(64),
    };
    const tampered = await first.daemon.execute({
      ...applyCommand(scanned.run, scanned.repair_approval),
      command_id: randomUUID(),
      binding: tamperedBinding,
    });
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.error.code).toBe("authorization_binding_mismatch");
    expect(first.artifacts.read(first.artifact)).toEqual(original);

    first.clock.advance(5 * 60 * 1000);
    const expired = await first.daemon.execute(applyCommand(scanned.run, scanned.repair_approval));
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe("authorization_expired");
    expect(first.artifacts.read(first.artifact)).toEqual(original);

    const replayCase = setup();
    const replayScan = await scanForRepair(replayCase.daemon, replayCase.artifact);
    expect(replayScan.scanned.ok).toBe(true);
    if (!replayScan.scanned.ok || !replayScan.scanned.repair_approval) return;
    const repair = applyCommand(replayScan.scanned.run, replayScan.scanned.repair_approval);
    const applied = await replayCase.daemon.execute(repair);
    expect(applied.ok).toBe(true);
    const replayed = await replayCase.daemon.execute(repair);
    expect(replayed).toEqual(applied);

    const mutated = setup();
    const mutationMessage = randomUUID();
    const mutationScan = await scanForRepair(mutated.daemon, mutated.artifact, mutationMessage);
    expect(mutationScan.scanned.ok).toBe(true);
    if (!mutationScan.scanned.ok || !mutationScan.scanned.repair_approval) return;
    const revised = await mutated.daemon.execute(stageCommand(mutated.artifact, mutationMessage, "Intended disclosure: changed scope."));
    expect(revised.ok).toBe(true);
    const stale = await mutated.daemon.execute(applyCommand(mutationScan.scanned.run, mutationScan.scanned.repair_approval));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("stale_identity");
    expect(mutated.artifacts.read(mutated.artifact)).toEqual(mutated.bytes);
  });

  it("invalidates a pending Repair Approval on restart before any engine call", async () => {
    const databasePath = `/tmp/peel-issue-6-${randomUUID()}.sqlite`;
    const clock = new FakeClock(1_700_000_000_000);
    const artifacts = new InMemoryArtifactStore(clock);
    const firstDaemon = new PeelDaemon({
      allowedRecipients: [RECIPIENT],
      artifactStore: artifacts,
      clock,
      scopeAssessor: new FakeScopeAssessor("no_mismatch_found"),
      databasePath,
    });
    const bytes = workbook();
    const artifact = artifacts.put(bytes, "hidden.xlsx");
    const { scanned } = await scanForRepair(firstDaemon, artifact);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok || !scanned.repair_approval) return;
    firstDaemon.close();

    const restarted = new PeelDaemon({
      allowedRecipients: [RECIPIENT],
      artifactStore: artifacts,
      clock,
      scopeAssessor: new FakeScopeAssessor("no_mismatch_found"),
      databasePath,
    });
    try {
      const recovered = restarted.getRun(scanned.run.run_id);
      expect(recovered?.state).toBe("refused");
      const apply = await restarted.execute(applyCommand(scanned.run, scanned.repair_approval));
      expect(apply.ok).toBe(false);
      if (!apply.ok) expect(apply.error.code).toBe("stale_state");
      expect(artifacts.read(artifact)).toEqual(bytes);
    } finally {
      restarted.close();
    }
  });

  it.each(["remaining_finding", "unexplained_change", "reader_failure", "parse_failure"] as const)(
    "destroys a candidate and refuses on Verification %s",
    async (failure) => {
    const base = setup();
    const defaultEngine = new FakeWorkbookEngine(base.artifacts);
    const daemon = new PeelDaemon({
      allowedRecipients: [RECIPIENT],
      artifactStore: base.artifacts,
      clock: base.clock,
      scopeAssessor: new FakeScopeAssessor("no_mismatch_found"),
      engine: {
        scan: (reference) => defaultEngine.scan(reference),
        repair: (reference, plan) => defaultEngine.repair!(reference, plan),
        verify: (reference, originalHash, plan, originalReference) => {
          if (failure === "parse_failure") return {} as ReturnType<NonNullable<EngineAdapter["verify"]>>;
          const verification = defaultEngine.verify(reference, originalHash, plan, originalReference);
          if (failure === "remaining_finding") {
            return {
              ...verification,
              status: "refused",
              remaining_findings: [{ mechanism: "hidden_worksheet", location: "xl/workbook.xml", count: 1 }],
            };
          }
          if (failure === "unexplained_change") return { ...verification, status: "verified", unexplained_changes: ["xl/theme/theme1.xml"] };
          return { ...verification, status: "verified", reopened_with: [] };
        },
      },
    });
    const artifact = base.artifacts.put(base.bytes, "hidden.xlsx");
    const { scanned } = await scanForRepair(daemon, artifact);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok || !scanned.repair_approval) return;
    const applied = await daemon.execute(applyCommand(scanned.run, scanned.repair_approval));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const candidate = applied.run.artifact;
    const verification = await daemon.execute({
      version: "1",
      command: "verify",
      command_id: randomUUID(),
      expected_state: "scanned",
      run_id: applied.run.run_id,
      revision: applied.run.revision,
      artifact_sha256: candidate.sha256,
    });
    expect(verification.ok).toBe(false);
    if (!verification.ok) expect(verification.error.code).toBe(failure === "parse_failure" ? "invalid_engine_result" : "verification_failed");
    expect(daemon.getRun(applied.run.run_id)?.state).toBe("refused");
    expect(base.artifacts.read(artifact)).toEqual(base.bytes);
    expect(() => base.artifacts.read(candidate)).toThrow();
    },
  );
});
