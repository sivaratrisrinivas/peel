import { randomUUID } from "node:crypto";

import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import type { EngineAdapter } from "../src/contracts.js";
import {
  FakeClock,
  FakeScopeAssessor,
  InMemoryArtifactStore,
  PeelDaemon,
} from "../src/daemon.js";
import { createPeelHttpServer } from "../src/http.js";

const RECIPIENT = "recipient@example.test";

function hiddenWorkbook(values: string[], secondSheetState = "veryHidden"): Uint8Array {
  const text = new TextEncoder();
  const sheet = (rows: string[]) => text.encode(
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
      .map((value, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>${value}</t></is></c></row>`)
      .join("")}</sheetData></worksheet>`,
  );
  return zipSync({
    "[Content_Types].xml": text.encode(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": text.encode("<Relationships/>"),
    "xl/workbook.xml": text.encode(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Visible" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Very Hidden" sheetId="3" state="${secondSheetState}" r:id="rId3"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": text.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": sheet([]),
    "xl/worksheets/sheet2.xml": sheet(values),
    "xl/worksheets/sheet3.xml": sheet(["second hidden value"]),
  });
}

function stageCommand(
  artifact: ReturnType<InMemoryArtifactStore["put"]>,
  messageUid = randomUUID(),
  body = "Intended disclosure: the visible worksheet only.",
) {
  return {
    version: "1",
    command: "stage",
    command_id: randomUUID(),
    expected_state: "new",
    trigger: {
      mailbox_account: "sender@example.test",
      folder_uidvalidity: "uidvalidity-issue-5",
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

function setup(values = ["secret row 1", "secret row 2", "secret row 3", "secret row 4", "secret row 5", "secret row 6"]) {
  const clock = new FakeClock(1_700_000_000_000);
  const artifacts = new InMemoryArtifactStore(clock);
  const daemon = new PeelDaemon({
    allowedRecipients: [RECIPIENT],
    artifactStore: artifacts,
    clock,
    scopeAssessor: new FakeScopeAssessor(),
  });
  const bytes = hiddenWorkbook(values);
  const artifact = artifacts.put(bytes, "hidden.xlsx");
  return { artifact, artifacts, bytes, clock, daemon };
}

async function scanHiddenWorkbook(daemon: PeelDaemon, artifact: ReturnType<InMemoryArtifactStore["put"]>) {
  const staged = await daemon.execute(stageCommand(artifact));
  expect(staged.ok).toBe(true);
  if (!staged.ok) throw new Error("stage failed in test setup");
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

describe("Issue #5 concealed-data Attack", () => {
  it("reports hidden worksheets regardless of their values and waits for the separate Repair Approval", async () => {
    const first = setup(["legitimate-looking value"]);
    const second = setup(["suspicious-looking secret"]);

    const firstScan = await scanHiddenWorkbook(first.daemon, first.artifact);
    const secondScan = await scanHiddenWorkbook(second.daemon, second.artifact);

    expect(firstScan.ok).toBe(true);
    expect(secondScan.ok).toBe(true);
    if (!firstScan.ok || !secondScan.ok) return;
    expect(firstScan.run.state).toBe("awaiting_repair_approval");
    expect(firstScan.run.scan?.findings).toEqual([
      { mechanism: "hidden_worksheet", location: "xl/workbook.xml", count: 2 },
    ]);
    expect(firstScan.run.scope_assessment?.status).toBe("no_mismatch_found");
    expect(secondScan.run.scan?.findings).toEqual(firstScan.run.scan?.findings);
    expect(firstScan.run.reveals).toBeUndefined();
    expect(JSON.stringify(firstScan)).not.toContain("legitimate-looking value");
    expect(JSON.stringify(first.daemon.getRun(firstScan.run.run_id))).not.toContain("legitimate-looking value");
    expect(first.artifacts.read(first.artifact)).toEqual(first.bytes);

    const disclosure = await first.daemon.execute({
      version: "1",
      command: "request_disclosure",
      command_id: randomUUID(),
      expected_state: "verified",
      run_id: firstScan.run.run_id,
      revision: firstScan.run.revision,
      artifact_sha256: first.artifact.sha256,
    });
    expect(disclosure.ok).toBe(false);
    if (!disclosure.ok) expect(disclosure.error.code).toBe("stale_state");
  });

  it("keeps Reveal values on the local short-lived path and caps each Finding at five rows", async () => {
    const { artifact, clock, artifacts } = setup();
    const scopeAssessor = new FakeScopeAssessor("no_mismatch_found");
    const revealDaemon = new PeelDaemon({
      allowedRecipients: [RECIPIENT],
      artifactStore: artifacts,
      clock,
      scopeAssessor,
      revealEnabled: true,
    });

    const staged = await revealDaemon.execute(stageCommand(artifact));
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const scanCommand = {
      version: "1" as const,
      command: "scan" as const,
      command_id: randomUUID(),
      expected_state: "staged" as const,
      run_id: staged.run.run_id,
      revision: staged.run.revision,
      artifact_sha256: artifact.sha256,
    };
    const scan = await revealDaemon.execute(scanCommand);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.run.reveals).toHaveLength(1);
    const reveal = scan.run.reveals?.[0];
    if (!reveal) return;
    expect(reveal.row_count).toBe(5);
    expect(JSON.stringify(scan)).not.toContain("secret row 1");

    const sample = revealDaemon.readReveal(scan.run.run_id, reveal.reference);
    expect(sample?.rows).toHaveLength(5);
    expect(sample?.rows[0]?.values).toEqual(["secret row 1"]);
    expect(JSON.stringify(revealDaemon.getRun(scan.run.run_id))).not.toContain("secret row 1");

    clock.advance(60_000);
    expect(revealDaemon.readReveal(scan.run.run_id, reveal.reference)).toBeUndefined();
    const replay = await revealDaemon.execute(scanCommand);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.run.reveals).toBeUndefined();
  });
});

describe("Issue #5 one-way Scope Assessment", () => {
  it("refuses a draft with missing Claimed Scope before any Finding can advance", async () => {
    const { artifact, daemon } = setup();
    const staged = await daemon.execute(stageCommand(artifact, randomUUID(), "A draft without scope."));

    expect(staged.ok).toBe(false);
    if (!staged.ok) expect(staged.error.code).toBe("insufficient_context");
  });

  it.each([
    ["mismatch", "scope_mismatch", false],
    ["insufficient_context", "scope_insufficient_context", false],
    ["no_mismatch_found", undefined, true],
  ] as const)("handles %s without authorizing progress", async (status, errorCode, succeeds) => {
    const { artifact, clock, artifacts } = setup();
    const daemon = new PeelDaemon({
      allowedRecipients: [RECIPIENT],
      artifactStore: artifacts,
      clock,
      scopeAssessor: new FakeScopeAssessor(status),
    });

    const scan = await scanHiddenWorkbook(daemon, artifact);
    expect(scan.ok).toBe(succeeds);
    if (succeeds) {
      if (!scan.ok) return;
      expect(scan.run.scope_assessment?.status).toBe(status);
      expect(scan.run.state).toBe("awaiting_repair_approval");
    } else {
      if (scan.ok) return;
      expect(scan.error.code).toBe(errorCode);
      expect(scan.run?.scope_assessment?.status).toBe(status);
      expect(scan.run?.state).toBe("refused");
    }
  });

  it("treats Scope Assessment model failure as a terminal Refusal", async () => {
    const { artifact, clock, artifacts } = setup();
    const scopeAssessor = new FakeScopeAssessor("no_mismatch_found");
    scopeAssessor.failNext = true;
    const daemon = new PeelDaemon({
      allowedRecipients: [RECIPIENT],
      artifactStore: artifacts,
      clock,
      scopeAssessor,
    });

    const scan = await scanHiddenWorkbook(daemon, artifact);
    expect(scan.ok).toBe(false);
    if (scan.ok) return;
    expect(scan.error.code).toBe("scope_assessment_failed");
    expect(scan.run?.state).toBe("refused");
    expect(scan.run?.scope_assessment).toBeUndefined();
  });
});

describe("Issue #5 local presentation boundary", () => {
  it("presents Finding metadata through MCP and keeps Reveal values on the local HTTP route", async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const artifacts = new InMemoryArtifactStore(clock);
    const engine: EngineAdapter = {
      scan: (reference) => ({
        version: "1",
        operation: "scan",
        status: "findings",
        artifact_sha256: reference.sha256,
        engine_version: "1.0.0",
        supported_profile: "accepted",
        findings: [{ mechanism: "hidden_worksheet", location: "xl/workbook.xml", count: 1 }],
        repair_plan: {
          version: "1",
          operation: "repair_plan",
          status: "eligible",
          artifact_sha256: reference.sha256,
          engine_version: "1.0.0",
          dependency_analysis: {
            visible_formulas: [],
            defined_names: [],
            data_validation: [],
            tables: [],
            charts: [],
            pivots: [],
            package_relationships: [],
            macros: [],
            external_connections: [],
          },
          actions: [{
            kind: "delete_hidden_worksheet",
            worksheet: "Hidden",
            target_member: "xl/worksheets/sheet2.xml",
            changed_members: ["[Content_Types].xml", "xl/_rels/workbook.xml.rels", "xl/workbook.xml", "xl/worksheets/sheet2.xml"],
            capability_losses: ["Hidden worksheet content will be removed."],
          }],
          changed_members: ["[Content_Types].xml", "xl/_rels/workbook.xml.rels", "xl/workbook.xml", "xl/worksheets/sheet2.xml"],
          capability_losses: ["Hidden worksheet content will be removed."],
        },
      }),
      reveal: () => [{ worksheet: "Hidden", row: 1, values: ["local-only secret"] }],
      verify: () => {
        throw new Error("verify is not part of this read-only journey");
      },
    };
    const daemon = new PeelDaemon({
      allowedRecipients: [RECIPIENT],
      artifactStore: artifacts,
      clock,
      engine,
      revealEnabled: true,
      scopeAssessor: new FakeScopeAssessor(),
    });
    const server = createPeelHttpServer(daemon);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server did not bind a port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const artifact = artifacts.put(new Uint8Array([1, 2, 3]), "hidden.xlsx");
      const stagedResponse = await fetch(`${baseUrl}/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stageCommand(artifact)),
      });
      const staged = (await stagedResponse.json()) as { run: { run_id: string; revision: number } };
      const runId = staged.run.run_id;
      const scanResponse = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "scan",
            arguments: {
              version: "1",
              command_id: randomUUID(),
              expected_state: "staged",
              run_id: runId,
              revision: staged.run.revision,
              artifact_sha256: artifact.sha256,
            },
          },
        }),
      });
      const mcp = (await scanResponse.json()) as { result: { content: Array<{ text: string }> } };
      const presented = JSON.parse(mcp.result.content[0]!.text) as {
        run: { scan: { findings: unknown[] }; reveals: Array<{ reference: string }> };
      };
      expect(presented.run.scan.findings).toEqual([
        { mechanism: "hidden_worksheet", location: "xl/workbook.xml", count: 1 },
      ]);
      expect(presented.run.reveals).toHaveLength(1);
      expect(JSON.stringify(presented)).not.toContain("local-only secret");

      const revealResponse = await fetch(`${baseUrl}/v1/runs/${runId}/reveals/${presented.run.reveals[0]!.reference}`);
      expect(revealResponse.status).toBe(200);
      expect(revealResponse.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await revealResponse.json())).toContain("local-only secret");
      clock.advance(60_000);
      const expiredRevealResponse = await fetch(`${baseUrl}/v1/runs/${runId}/reveals/${presented.run.reveals[0]!.reference}`);
      expect(expiredRevealResponse.status).toBe(404);
      expect(JSON.stringify(await expiredRevealResponse.json())).not.toContain("local-only secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      daemon.close();
    }
  });
});
