import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { unzipSync } from "fflate";

import {
  ENGINE_VERSION,
  MAX_ARTIFACT_BYTES,
  type ArtifactReference,
  type ArtifactStore,
  type Clock,
  type DeliveryOutcome,
  type DisclosureMailer,
  type DisclosureMessage,
  type EngineAdapter,
  type EngineScanResult,
  type EngineRepairResult,
  type EngineVerifyResult,
  type Finding,
  type RevealRow,
  type ScopeAssessor,
  type ScopeAssessmentInput,
  type ScopeAssessmentResult,
  type ScopeAssessmentStatus,
  type RepairPlan,
} from "./contracts.js";
import { repairPlanHash, sha256 } from "./identity.js";
import { repairWorkbook, revealPivotCache, scanWorkbook, verifyWorkbook } from "./repair.js";

export class ArtifactError extends Error {
  readonly code: "expired_artifact" | "undeclared_artifact" | "integrity_failure";

  constructor(code: ArtifactError["code"]) {
    super(code);
    this.name = "ArtifactError";
    this.code = code;
  }
}

interface StoredArtifact {
  bytes: Uint8Array;
  filename: string;
  sha256: string;
  byteSize: number;
  expiresAt: number;
}

export class FakeClock implements Clock {
  private currentTime: number;

  constructor(initialTime = Date.now()) {
    this.currentTime = initialTime;
  }

  now(): number {
    return this.currentTime;
  }

  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError("clock advancement must be a non-negative integer");
    }
    this.currentTime += milliseconds;
  }
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FakeScopeAssessor implements ScopeAssessor {
  failNext = false;

  constructor(private readonly status: ScopeAssessmentStatus = "no_mismatch_found") {}

  assess(_input: ScopeAssessmentInput): ScopeAssessmentResult {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("scope assessment failed");
    }
    return {
      version: "1",
      operation: "scope_assessment",
      status: this.status,
    };
  }
}

export class UnavailableScopeAssessor implements ScopeAssessor {
  assess(_input: ScopeAssessmentInput): ScopeAssessmentResult {
    return {
      version: "1",
      operation: "scope_assessment",
      status: "insufficient_context",
    };
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  put(bytes: Uint8Array, filename: string, ttlMs = 15 * 60 * 1000): ArtifactReference {
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new ArtifactError("integrity_failure");
    if (!filename.toLowerCase().endsWith(".xlsx")) throw new ArtifactError("integrity_failure");
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError("artifact TTL must be positive");
    const copy = new Uint8Array(bytes);
    const reference = `peel-artifact-${randomBytes(16).toString("base64url")}`;
    const digest = sha256(copy);
    this.artifacts.set(reference, {
      bytes: copy,
      filename,
      sha256: digest,
      byteSize: copy.byteLength,
      expiresAt: this.clock.now() + ttlMs,
    });
    return {
      reference,
      filename,
      media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byte_size: copy.byteLength,
      sha256: digest,
    };
  }

  read(reference: ArtifactReference): Uint8Array {
    const stored = this.artifacts.get(reference.reference);
    if (!stored) throw new ArtifactError("undeclared_artifact");
    if (this.clock.now() >= stored.expiresAt) throw new ArtifactError("expired_artifact");
    if (
      stored.filename !== reference.filename ||
      stored.byteSize !== reference.byte_size ||
      stored.sha256 !== reference.sha256
    ) {
      throw new ArtifactError("integrity_failure");
    }
    const copy = new Uint8Array(stored.bytes);
    if (copy.byteLength !== reference.byte_size || sha256(copy) !== reference.sha256) {
      throw new ArtifactError("integrity_failure");
    }
    return copy;
  }

  expire(reference: ArtifactReference): void {
    const stored = this.artifacts.get(reference.reference);
    if (stored) stored.expiresAt = this.clock.now() - 1;
  }

  corrupt(reference: ArtifactReference, bytes = new Uint8Array([0])): void {
    const stored = this.artifacts.get(reference.reference);
    if (stored) stored.bytes = new Uint8Array(bytes);
  }

  discard(reference: ArtifactReference): void {
    this.artifacts.delete(reference.reference);
  }
}

export class FakeDisclosureMailer implements DisclosureMailer {
  readonly calls: DisclosureMessage[] = [];
  nextOutcome: DeliveryOutcome = "accepted";

  deliver(message: DisclosureMessage, _idempotencyKey: string): DeliveryOutcome {
    this.calls.push({ ...message, bytes: new Uint8Array(message.bytes) });
    const outcome = this.nextOutcome;
    this.nextOutcome = "accepted";
    return outcome;
  }
}

interface BridgeResponse {
  result?: unknown;
  candidate_bytes_base64?: unknown;
  status?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runPythonBridge(script: string, input: unknown): BridgeResponse {
  const result = spawnSync(
    process.env.PEEL_PYTHON_BIN ?? "python3",
    [script],
    {
      cwd: process.cwd(),
      input: JSON.stringify(input),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("external adapter failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("external adapter returned invalid JSON");
  }
  if (!isRecord(parsed)) throw new Error("external adapter returned an invalid response");
  return parsed;
}

export class DaytonaWorkbookEngine implements EngineAdapter {
  private readonly bridgePath: string;

  constructor(
    private readonly artifacts: ArtifactStore,
    bridgePath = process.env.PEEL_DAYTONA_BRIDGE ?? "scripts/daytona_engine_bridge.py",
  ) {
    this.bridgePath = bridgePath;
  }

  scan(reference: ArtifactReference): EngineScanResult {
    const response = this.invoke("scan", reference);
    return response.result as EngineScanResult;
  }

  repair(reference: ArtifactReference, plan: RepairPlan): EngineRepairResult {
    const response = this.invoke("repair", reference, undefined, plan);
    const result = response.result;
    if (!isRecord(result)) throw new Error("Daytona repair returned an invalid result");
    if (result.status !== "repaired") return result as unknown as EngineRepairResult;
    if (typeof response.candidate_bytes_base64 !== "string") throw new Error("Daytona repair returned no declared artifact");
    let candidateBytes: Buffer;
    try {
      candidateBytes = Buffer.from(response.candidate_bytes_base64, "base64");
    } catch {
      throw new Error("Daytona repair returned invalid artifact bytes");
    }
    const candidate = this.artifacts.put(new Uint8Array(candidateBytes), reference.filename);
    return { ...(result as unknown as EngineRepairResult), candidate_artifact: candidate };
  }

  verify(
    reference: ArtifactReference,
    originalArtifactSha256: string,
    plan?: RepairPlan,
    originalReference?: ArtifactReference,
  ): EngineVerifyResult {
    const response = this.invoke("verify", reference, originalArtifactSha256, plan, originalReference);
    return response.result as EngineVerifyResult;
  }

  private invoke(
    operation: "scan" | "repair" | "verify",
    reference: ArtifactReference,
    originalArtifactSha256?: string,
    plan?: RepairPlan,
    originalReference?: ArtifactReference,
  ): BridgeResponse {
    const bytes = this.artifacts.read(reference);
    const response = runPythonBridge(this.bridgePath, {
      operation,
      artifact: {
        filename: reference.filename,
        byte_size: reference.byte_size,
        sha256: reference.sha256,
      },
      bytes_base64: Buffer.from(bytes).toString("base64"),
      ...(originalArtifactSha256 ? { original_artifact_sha256: originalArtifactSha256 } : {}),
      ...(plan ? { repair_plan: plan } : {}),
      ...(originalReference ? { original_bytes_base64: Buffer.from(this.artifacts.read(originalReference)).toString("base64") } : {}),
    });
    if (!isRecord(response.result)) throw new Error("Daytona engine returned no result");
    return response;
  }
}

export class SmtpDisclosureMailer implements DisclosureMailer {
  private readonly bridgePath: string;

  constructor(
    bridgePath = process.env.PEEL_SMTP_BRIDGE ?? "scripts/smtp_delivery_bridge.py",
  ) {
    this.bridgePath = bridgePath;
  }

  deliver(message: DisclosureMessage, idempotencyKey: string): DeliveryOutcome {
    if (
      message.bytes.byteLength !== message.attachment.byte_size ||
      sha256(message.bytes) !== message.attachment.sha256
    ) {
      throw new ArtifactError("integrity_failure");
    }
    this.recordInvocation();
    const response = runPythonBridge(this.bridgePath, {
      idempotency_key: idempotencyKey,
      sender: message.sender,
      recipient: message.recipient,
      subject: message.subject,
      body: message.body,
      attachment: {
        filename: message.attachment.filename,
        media_type: message.attachment.media_type,
        sha256: message.attachment.sha256,
      },
      bytes_base64: Buffer.from(message.bytes).toString("base64"),
    });
    if (response.status === "accepted") return "accepted";
    if (response.status === "rejected") return "rejected";
    if (response.status === "ambiguous") return "ambiguous";
    throw new Error("SMTP bridge returned an invalid outcome");
  }

  private recordInvocation(): void {
    const auditPath = process.env.PEEL_SMTP_AUDIT_FILE;
    if (!auditPath) return;
    appendFileSync(auditPath, "delivery_invocation\n", { encoding: "utf8" });
  }
}

const PROFILE_FILES = new Set([
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/app.xml",
  "docProps/core.xml",
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
  "xl/styles.xml",
  "xl/sharedStrings.xml",
]);

function allowedProfilePart(name: string): boolean {
  return (
    PROFILE_FILES.has(name) ||
    name.startsWith("xl/worksheets/") && name.endsWith(".xml") ||
    name.startsWith("xl/theme/") && name.endsWith(".xml") ||
    name.startsWith("_rels/") && name.endsWith(".rels") ||
    name.startsWith("xl/worksheets/_rels/") && name.endsWith(".rels")
  );
}

function localElement(element: string): string {
  return `(?:[A-Za-z_][\\w.-]*:)?(?:${element})`;
}

function profileIsAccepted(files: Record<string, Uint8Array>): boolean {
  const contentTypes = files["[Content_Types].xml"];
  const workbook = files["xl/workbook.xml"];
  if (!contentTypes || !workbook || !files["xl/worksheets/sheet1.xml"]) return false;
  const contentTypeText = new TextDecoder().decode(contentTypes);
  if (!contentTypeText.includes("spreadsheetml.sheet.main+xml")) return false;
  return Object.keys(files).every(allowedProfilePart);
}

function hiddenFindings(workbook: Uint8Array, files: Record<string, Uint8Array>): Finding[] {
  const workbookXml = new TextDecoder().decode(workbook);
  const findings: Finding[] = [];
  const hiddenSheets = workbookXml.match(new RegExp(`<${localElement("sheet")}\\b[^>]*\\bstate=["'](?:hidden|veryHidden)["'][^>]*>`, "gi")) ?? [];
  if (hiddenSheets.length > 0) {
    findings.push({ mechanism: "hidden_worksheet", location: "xl/workbook.xml", count: hiddenSheets.length });
  }
  const hiddenRowsOrColumns = Object.entries(files).reduce((count, [name, bytes]) => {
    if (!name.startsWith("xl/worksheets/") || !name.endsWith(".xml")) return count;
    const xml = new TextDecoder().decode(bytes);
    return count + (xml.match(new RegExp(`<${localElement("row|col")}\\b[^>]*\\bhidden=["'](?:1|true)["'][^>]*>`, "gi")) ?? []).length;
  }, 0);
  if (hiddenRowsOrColumns > 0) {
    findings.push({ mechanism: "hidden_row_or_column", location: "xl/worksheets", count: hiddenRowsOrColumns });
  }
  return findings;
}

interface WorkbookSheet {
  name: string;
  state: string | undefined;
  relationshipId: string;
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name.replace(":", "\\:")}=["']([^"']*)["']`, "i"));
  return match?.[1];
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function workbookSheets(workbookXml: string): WorkbookSheet[] {
  return Array.from(workbookXml.matchAll(new RegExp(`<${localElement("sheet")}\\b([^>]*)\\/?>(?:<\\/${localElement("sheet")}>)?`, "gi")), (match) => ({
    name: decodeXml(xmlAttribute(match[1]!, "name") ?? ""),
    state: xmlAttribute(match[1]!, "state")?.toLowerCase(),
    relationshipId: xmlAttribute(match[1]!, "r:id") ?? xmlAttribute(match[1]!, "id") ?? "",
  }));
}

function worksheetPath(workbookRels: string, relationshipId: string): string | undefined {
  for (const match of workbookRels.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi)) {
    if (xmlAttribute(match[1]!, "Id") !== relationshipId) continue;
    const target = xmlAttribute(match[1]!, "Target");
    if (!target) return undefined;
    const normalized = target.replace(/^\/+/, "");
    return normalized.startsWith("xl/") ? normalized : `xl/${normalized.replace(/^\.\//, "")}`;
  }
  return undefined;
}

function sharedStringValues(files: Record<string, Uint8Array>): string[] {
  const sharedStrings = files["xl/sharedStrings.xml"];
  if (!sharedStrings) return [];
  const xml = new TextDecoder().decode(sharedStrings);
  return Array.from(xml.matchAll(new RegExp("<" + localElement("si") + "\\b[^>]*>([\\s\\S]*?)</" + localElement("si") + ">", "gi")), (match) => (
    Array.from(match[1]!.matchAll(new RegExp("<" + localElement("t") + "\\b[^>]*>([\\s\\S]*?)</" + localElement("t") + ">", "gi")), (text) => decodeXml(text[1]!)).join("")
  ));
}

function columnNumber(column: string): number {
  let result = 0;
  for (const character of column.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function cellColumn(reference: string): number | undefined {
  const match = reference.match(/^[A-Z]{1,3}/i);
  return match ? columnNumber(match[0]) : undefined;
}

function hiddenColumnRanges(xml: string): Array<[number, number]> {
  return Array.from(xml.matchAll(new RegExp("<" + localElement("col") + "\\b([^>]*)\\/?>(?:</" + localElement("col") + ">)?", "gi")))
    .filter((match) => /(?:^|\s)hidden=["'](?:1|true)["']/i.test(match[1] ?? ""))
    .flatMap((match) => {
      const minimum = Number(xmlAttribute(match[1] ?? "", "min"));
      const maximum = Number(xmlAttribute(match[1] ?? "", "max"));
      return Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum) && minimum > 0 && maximum >= minimum
        ? [[minimum, maximum] as [number, number]]
        : [];
    });
}

function rowValues(
  rowXml: string,
  sharedStrings: readonly string[],
  hiddenColumns?: readonly [number, number][],
): string[] {
  return Array.from(rowXml.matchAll(new RegExp("<" + localElement("c") + "\\b([^>]*)>([\\s\\S]*?)</" + localElement("c") + ">", "gi")), (match) => {
    const attributes = match[1]!;
    const content = match[2]!;
    if (hiddenColumns) {
      const column = cellColumn(xmlAttribute(attributes, "r") ?? "");
      if (column === undefined || !hiddenColumns.some(([minimum, maximum]) => column >= minimum && column <= maximum)) return undefined;
    }
    const type = xmlAttribute(attributes, "t");
    if (type?.toLowerCase() === "inlinestr") {
      return decodeXml(content.match(new RegExp("<" + localElement("t") + "\\b[^>]*>([\\s\\S]*?)</" + localElement("t") + ">", "i"))?.[1] ?? "");
    }
    const value = decodeXml(content.match(new RegExp("<" + localElement("v") + "\\b[^>]*>([\\s\\S]*?)</" + localElement("v") + ">", "i"))?.[1] ?? "");
    if (type?.toLowerCase() === "s") {
      const index = Number(value);
      return Number.isSafeInteger(index) && sharedStrings[index] !== undefined ? sharedStrings[index]! : value;
    }
    return value;
  }).filter((value): value is string => value !== undefined);
}

function rowsFromWorksheet(
  xml: string,
  worksheet: string,
  hiddenOnly: boolean,
  sharedStrings: readonly string[],
  maxRows: number,
): RevealRow[] {
  const rows: RevealRow[] = [];
  const columns = hiddenOnly ? hiddenColumnRanges(xml) : [];
  for (const match of xml.matchAll(new RegExp("<" + localElement("row") + "\\b([^>]*)>([\\s\\S]*?)</" + localElement("row") + ">", "gi"))) {
    if (rows.length >= maxRows) break;
    const attributes = match[1]!;
    const rowHidden = /(?:^|\s)hidden=["'](?:1|true)["']/i.test(attributes);
    if (hiddenOnly && !rowHidden && columns.length === 0) continue;
    const rowNumber = Number(xmlAttribute(attributes, "r"));
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) continue;
    const values = rowValues(match[2]!, sharedStrings, hiddenOnly && !rowHidden ? columns : undefined).slice(0, 128);
    if (hiddenOnly && values.length === 0) continue;
    rows.push({ worksheet, row: rowNumber, values });
  }
  return rows;
}

export class FakeWorkbookEngine implements EngineAdapter {
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly options: { repairEnabled?: boolean } = {},
  ) {}

  scan(reference: ArtifactReference): EngineScanResult {
    try {
      return scanWorkbook(this.artifacts.read(reference), reference.sha256);
    } catch (error) {
      return {
        version: "1",
        operation: "scan",
        status: "refused",
        artifact_sha256: reference.sha256,
        engine_version: ENGINE_VERSION,
        supported_profile: "refused",
        findings: [],
        refusal_code: error instanceof ArtifactError ? "integrity_failure" : "unsupported_container",
      };
    }
  }

  repair(reference: ArtifactReference, plan: RepairPlan): EngineRepairResult {
    if (this.options.repairEnabled === false) {
      return {
        version: "1",
        operation: "repair",
        status: "refused",
        artifact_sha256: reference.sha256,
        original_artifact_sha256: reference.sha256,
        engine_version: ENGINE_VERSION,
        repair_plan_sha256: repairPlanHash(plan),
        changed_members: [],
        refusal_code: "unsupported_content",
      };
    }
    const originalBytes = this.artifacts.read(reference);
    try {
      const repaired = repairWorkbook(originalBytes, plan, reference.sha256);
      const candidate = this.artifacts.put(repaired.bytes, reference.filename);
      return {
        version: "1",
        operation: "repair",
        status: "repaired",
        artifact_sha256: candidate.sha256,
        original_artifact_sha256: reference.sha256,
        engine_version: ENGINE_VERSION,
        repair_plan_sha256: repairPlanHash(plan),
        changed_members: repaired.changedMembers,
        candidate_artifact: candidate,
      };
    } catch {
      return {
        version: "1",
        operation: "repair",
        status: "refused",
        artifact_sha256: reference.sha256,
        original_artifact_sha256: reference.sha256,
        engine_version: ENGINE_VERSION,
        repair_plan_sha256: repairPlanHash(plan),
        changed_members: [],
        refusal_code: "integrity_failure",
      };
    }
  }

  reveal(reference: ArtifactReference, finding: Finding): RevealRow[] {
    const bytes = this.artifacts.read(reference);
    const files = unzipSync(bytes);
    const workbookXml = new TextDecoder().decode(files["xl/workbook.xml"] ?? new Uint8Array());
    const workbookRels = new TextDecoder().decode(files["xl/_rels/workbook.xml.rels"] ?? new Uint8Array());
    const sheets = workbookSheets(workbookXml);
    const sharedStrings = sharedStringValues(files);
    const hiddenSheets = sheets.filter((sheet) => sheet.state === "hidden" || sheet.state === "veryhidden");
    const rows: RevealRow[] = [];

    if (finding.mechanism === "hidden_worksheet") {
      for (const sheet of hiddenSheets) {
        const path = worksheetPath(workbookRels, sheet.relationshipId);
        const worksheet = path ? files[path] : undefined;
        if (!worksheet) continue;
        rows.push(...rowsFromWorksheet(new TextDecoder().decode(worksheet), sheet.name, false, sharedStrings, 5 - rows.length));
        if (rows.length >= 5) break;
      }
    } else if (finding.mechanism === "hidden_row_or_column") {
      for (const sheet of sheets) {
        const path = worksheetPath(workbookRels, sheet.relationshipId);
        const worksheet = path ? files[path] : undefined;
        if (!worksheet) continue;
        rows.push(...rowsFromWorksheet(new TextDecoder().decode(worksheet), sheet.name, true, sharedStrings, 5 - rows.length));
        if (rows.length >= 5) break;
      }
    } else if (finding.mechanism === "pivot_cache") {
      rows.push(...revealPivotCache(bytes, finding));
    }

    return rows;
  }

  verify(
    reference: ArtifactReference,
    originalArtifactSha256: string,
    plan?: RepairPlan,
    originalReference?: ArtifactReference,
  ): EngineVerifyResult {
    const candidateBytes = this.artifacts.read(reference);
    const originalBytes = originalReference ? this.artifacts.read(originalReference) : candidateBytes;
    return verifyWorkbook(candidateBytes, originalBytes, originalArtifactSha256, reference.sha256, plan);
  }
}
