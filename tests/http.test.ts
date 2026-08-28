import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { FakeClock, FakeDisclosureMailer, InMemoryArtifactStore, PeelDaemon } from "../src/daemon.js";
import { createPeelHttpServer } from "../src/http.js";

describe("Peel HTTP and MCP boundary", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("uploads an opaque Artifact Reference and accepts the same public command through MCP", async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const daemon = new PeelDaemon({
      allowedRecipients: ["recipient@example.test"],
      artifactStore: new InMemoryArtifactStore(clock),
      clock,
      disclosureMailer: new FakeDisclosureMailer(),
    });
    const server = createPeelHttpServer(daemon);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server did not bind a port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const upload = await fetch(`${baseUrl}/v1/artifacts`, {
      method: "POST",
      headers: { "x-artifact-filename": "manual.xlsx" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as { artifact: { reference: string; sha256: string; byte_size: number; filename: string; media_type: string } };

    const initialize = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(initialize.status).toBe(200);
    const initialized = (await initialize.json()) as { result: { capabilities: { tools: object } } };
    expect(initialized.result.capabilities.tools).toEqual({});

    const stage = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "stage",
          arguments: {
            version: "1",
            command_id: randomUUID(),
            expected_state: "new",
            trigger: {
              mailbox_account: "sender@example.test",
              folder_uidvalidity: "folder-1",
              message_uid: "message-1",
              attachment_sha256: uploaded.artifact.sha256,
            },
            envelope: {
              sender: "sender@example.test",
              recipient: "recipient@example.test",
              subject: "Manual workbook",
              body: "Intended disclosure: the workbook.",
              attachment: uploaded.artifact,
            },
          },
        },
      }),
    });
    expect(stage.status).toBe(200);
    const staged = (await stage.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(staged.result.isError).toBe(false);
    expect(JSON.parse(staged.result.content[0]!.text)).toMatchObject({ ok: true, run: { state: "staged" } });
    daemon.close();
  });

  it("publishes send_email as the native approval-gated Disclosure tool", async () => {
    const daemon = new PeelDaemon({ allowedRecipients: ["recipient@example.test"] });
    const server = createPeelHttpServer(daemon);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server did not bind a port");

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result: { tools: Array<{ name: string; inputSchema: { required: string[]; properties: Record<string, unknown> } }> };
    };
    const sendEmail = payload.result.tools.find((tool) => tool.name === "send_email");
    expect(sendEmail).toBeDefined();
    expect(sendEmail?.inputSchema.required).toEqual(expect.arrayContaining([
      "approval_id",
      "idempotency_key",
      "binding",
      "run_id",
      "revision",
      "artifact_sha256",
    ]));
    expect(sendEmail?.inputSchema.properties).not.toHaveProperty("decision");
    daemon.close();
  });

  it("maps an approved send_email call to the daemon Disclosure command", async () => {
    const mailer = new FakeDisclosureMailer();
    const daemon = new PeelDaemon({
      allowedRecipients: ["recipient@example.test"],
      disclosureMailer: mailer,
      engine: {
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
          artifact_unchanged: true,
          baseline_sha256: originalArtifactSha256,
          remaining_findings: [],
        }),
      },
    });
    const server = createPeelHttpServer(daemon);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server did not bind a port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const artifact = daemon.uploadArtifact(new Uint8Array([1, 2, 3]), "clean.xlsx");
    const staged = await daemon.execute({
      version: "1",
      command: "stage",
      command_id: randomUUID(),
      expected_state: "new",
      trigger: {
        mailbox_account: "sender@example.test",
        folder_uidvalidity: "folder-1",
        message_uid: "message-1",
        attachment_sha256: artifact.sha256,
      },
      envelope: {
        sender: "sender@example.test",
        recipient: "recipient@example.test",
        subject: "Clean workbook",
        body: "Intended disclosure: the visible workbook.",
        attachment: artifact,
      },
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const run = staged.run;
    for (const [command, expectedState] of [["scan", "staged"], ["verify", "scanned"]] as const) {
      const result = await daemon.execute({
        version: "1",
        command,
        command_id: randomUUID(),
        expected_state: expectedState,
        run_id: run.run_id,
        revision: run.revision,
        artifact_sha256: artifact.sha256,
      });
      expect(result.ok).toBe(true);
    }
    const requested = await daemon.execute({
      version: "1",
      command: "request_disclosure",
      command_id: randomUUID(),
      expected_state: "verified",
      run_id: run.run_id,
      revision: run.revision,
      artifact_sha256: artifact.sha256,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.approval) return;

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "send_email",
          arguments: {
            version: "1",
            command_id: randomUUID(),
            expected_state: "awaiting_disclosure_approval",
            run_id: run.run_id,
            revision: run.revision,
            artifact_sha256: artifact.sha256,
            approval_id: requested.approval.approval_id,
            idempotency_key: requested.approval.idempotency_key,
            binding: requested.approval.binding,
          },
        },
      }),
    });
    const payload = (await response.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(payload.result.isError).toBe(false);
    expect(JSON.parse(payload.result.content[0]!.text)).toMatchObject({ ok: true, run: { state: "disclosed" } });
    expect(mailer.calls).toHaveLength(1);
    daemon.close();
  });
});
