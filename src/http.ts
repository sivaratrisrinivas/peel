import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { API_VERSION, type ApiResponse } from "./contracts.js";
import type { PeelDaemon } from "./daemon.js";

const MAX_JSON_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function statusFor(result: ApiResponse): number {
  if (result.ok) return 200;
  if (result.error.code === "invalid_schema") return 400;
  if (result.error.code === "run_not_found") return 404;
  if (result.error.code === "stale_state" || result.error.code === "stale_identity") return 409;
  return 422;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > limit) throw new HttpFailure(413, "request_too_large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) throw new HttpFailure(413, "request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function jsonRpcError(id: unknown, code: number, message: string): JsonRecord {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

const uuidSchema = { type: "string", format: "uuid" };
const hashSchema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const artifactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reference", "filename", "media_type", "byte_size", "sha256"],
  properties: {
    reference: { type: "string", pattern: "^peel-artifact-[A-Za-z0-9_-]{22}$" },
    filename: { type: "string", pattern: "^[^\\\\/]+\\.xlsx$" },
    media_type: { const: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    byte_size: { type: "integer", minimum: 0, maximum: 10485760 },
    sha256: hashSchema,
  },
};
const triggerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mailbox_account", "folder_uidvalidity", "message_uid", "attachment_sha256"],
  properties: {
    mailbox_account: { type: "string", minLength: 1 },
    folder_uidvalidity: { type: "string", minLength: 1 },
    message_uid: { type: "string", minLength: 1 },
    attachment_sha256: hashSchema,
  },
};
const envelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sender", "recipient", "subject", "body", "attachment"],
  properties: {
    sender: { type: "string", minLength: 1 },
    recipient: { type: "string", minLength: 1 },
    subject: { type: "string", minLength: 1 },
    body: { type: "string", minLength: 1 },
    attachment: artifactSchema,
  },
};
const bindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "revision", "envelope_revision_hash", "artifact_sha256", "sender", "recipient", "subject", "attachment_filename", "body_sha256"],
  properties: {
    run_id: uuidSchema,
    revision: { type: "integer", minimum: 1 },
    envelope_revision_hash: hashSchema,
    artifact_sha256: hashSchema,
    sender: { type: "string", minLength: 1 },
    recipient: { type: "string", minLength: 1 },
    subject: { type: "string", minLength: 1 },
    attachment_filename: { type: "string", minLength: 1 },
    body_sha256: hashSchema,
  },
};

function toolSchema(name: string): JsonRecord {
  const commonProperties = {
    version: { const: "1" },
    command_id: uuidSchema,
    run_id: uuidSchema,
    revision: { type: "integer", minimum: 1 },
    artifact_sha256: hashSchema,
  };
  if (name === "stage") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["version", "command_id", "expected_state", "trigger", "envelope"],
      properties: {
        version: commonProperties.version,
        command_id: commonProperties.command_id,
        expected_state: { const: "new" },
        trigger: triggerSchema,
        envelope: envelopeSchema,
      },
    };
  }
  if (name === "respond_disclosure") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["version", "command_id", "expected_state", "run_id", "revision", "artifact_sha256", "approval_id", "idempotency_key", "decision", "binding"],
      properties: {
        ...commonProperties,
        expected_state: { const: "awaiting_disclosure_approval" },
        approval_id: uuidSchema,
        idempotency_key: uuidSchema,
        decision: { enum: ["approve", "deny"] },
        binding: bindingSchema,
      },
    };
  }
  const expectedState = name === "scan" ? "staged" : name === "verify" ? "scanned" : "verified";
  return {
    type: "object",
    additionalProperties: false,
    required: ["version", "command_id", "expected_state", "run_id", "revision", "artifact_sha256"],
    properties: { ...commonProperties, expected_state: { const: expectedState } },
  };
}

function toolDefinitions(): JsonRecord[] {
  const names = ["stage", "scan", "verify", "request_disclosure", "respond_disclosure"];
  return names.map((name) => ({
    name,
    description: `Execute the governed ${name} command.`,
    inputSchema: toolSchema(name),
  }));
}

async function handleMcp(daemon: PeelDaemon, payload: unknown): Promise<JsonRecord> {
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || payload.id === undefined || typeof payload.method !== "string") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }
  const id = payload.id;
  if (payload.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "peel", version: API_VERSION },
      },
    };
  }
  if (payload.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: toolDefinitions() } };
  }
  if (payload.method !== "tools/call" || !isRecord(payload.params)) {
    return jsonRpcError(id, -32601, "Unsupported MCP method");
  }
  const name = payload.params.name;
  const args = payload.params.arguments;
  if (typeof name !== "string" || !isRecord(args) || !["stage", "scan", "verify", "request_disclosure", "respond_disclosure"].includes(name)) {
    return jsonRpcError(id, -32602, "Invalid tool call");
  }
  const result = await daemon.execute({ ...args, command: name });
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError: !result.ok,
      content: [{ type: "text", text: JSON.stringify(result) }],
    },
  };
}

export function createPeelHttpServer(daemon: PeelDaemon): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { version: API_VERSION, status: "ok" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/artifacts") {
        const filename = request.headers["x-artifact-filename"];
        if (typeof filename !== "string" || filename.trim() === "") throw new HttpFailure(400, "filename_required");
        const bytes = await readBody(request, MAX_UPLOAD_BYTES);
        const artifact = daemon.uploadArtifact(new Uint8Array(bytes), filename);
        writeJson(response, 201, { version: API_VERSION, ok: true, artifact });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/commands") {
        const bytes = await readBody(request, MAX_JSON_BYTES);
        let payload: unknown;
        try {
          payload = JSON.parse(bytes.toString("utf8")) as unknown;
        } catch {
          throw new HttpFailure(400, "invalid_json");
        }
        const result = await daemon.execute(payload);
        writeJson(response, statusFor(result), result);
        return;
      }
      const revealMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/reveals\/([^/]+)$/);
      if (request.method === "GET" && revealMatch) {
        if (!isLoopback(request)) {
          writeJson(response, 403, {
            version: API_VERSION,
            ok: false,
            error: { code: "reveal_private_only", message: "Reveal values are available only over the local Peel boundary." },
          });
          return;
        }
        const runId = decodeURIComponent(revealMatch[1]!);
        const reference = decodeURIComponent(revealMatch[2]!);
        const reveal = daemon.readReveal(runId, reference);
        if (!reveal) {
          writeJson(response, 404, {
            version: API_VERSION,
            ok: false,
            error: { code: "reveal_not_found", message: "The Reveal Reference is missing, expired, or not bound to this Run." },
          });
          return;
        }
        writeJson(response, 200, { version: API_VERSION, ok: true, reveal }, { "cache-control": "no-store" });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/runs/")) {
        const runId = decodeURIComponent(url.pathname.slice("/v1/runs/".length));
        const run = daemon.getRun(runId);
        if (!run) {
          writeJson(response, 404, { version: API_VERSION, ok: false, error: { code: "run_not_found", message: "The Run does not exist." } });
          return;
        }
        writeJson(response, 200, { version: API_VERSION, ok: true, run });
        return;
      }
      if (request.method === "POST" && url.pathname === "/mcp") {
        const bytes = await readBody(request, MAX_JSON_BYTES);
        let payload: unknown;
        try {
          payload = JSON.parse(bytes.toString("utf8")) as unknown;
        } catch {
          throw new HttpFailure(400, "invalid_json");
        }
        writeJson(response, 200, await handleMcp(daemon, payload));
        return;
      }
      writeJson(response, 404, { version: API_VERSION, ok: false, error: { code: "not_found", message: "The endpoint does not exist." } });
    } catch (error) {
      if (error instanceof HttpFailure) {
        writeJson(response, error.status, { version: API_VERSION, ok: false, error: { code: error.code, message: "The request was refused safely." } });
        return;
      }
      writeJson(response, 500, { version: API_VERSION, ok: false, error: { code: "internal_error", message: "The request could not be completed safely." } });
    }
  });
}
