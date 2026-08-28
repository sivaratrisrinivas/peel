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
  type EngineVerifyResult,
  type Finding,
} from "./contracts.js";
import { sha256 } from "./identity.js";

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
  const hiddenSheets = workbookXml.match(/<sheet\b[^>]*\bstate=["'](?:hidden|veryHidden)["'][^>]*>/gi) ?? [];
  if (hiddenSheets.length > 0) {
    findings.push({ mechanism: "hidden_worksheet", location: "xl/workbook.xml", count: hiddenSheets.length });
  }
  const hiddenRowsOrColumns = Object.entries(files).reduce((count, [name, bytes]) => {
    if (!name.startsWith("xl/worksheets/") || !name.endsWith(".xml")) return count;
    const xml = new TextDecoder().decode(bytes);
    return count + (xml.match(/<(?:row|col)\b[^>]*\bhidden=["'](?:1|true)["'][^>]*>/gi) ?? []).length;
  }, 0);
  if (hiddenRowsOrColumns > 0) {
    findings.push({ mechanism: "hidden_row_or_column", location: "xl/worksheets", count: hiddenRowsOrColumns });
  }
  return findings;
}

export class FakeWorkbookEngine implements EngineAdapter {
  constructor(private readonly artifacts: ArtifactStore) {}

  scan(reference: ArtifactReference): EngineScanResult {
    let bytes: Uint8Array;
    try {
      bytes = this.artifacts.read(reference);
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
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes);
    } catch {
      return {
        version: "1",
        operation: "scan",
        status: "refused",
        artifact_sha256: reference.sha256,
        engine_version: ENGINE_VERSION,
        supported_profile: "refused",
        findings: [],
        refusal_code: "unsupported_container",
      };
    }
    if (!profileIsAccepted(files)) {
      return {
        version: "1",
        operation: "scan",
        status: "refused",
        artifact_sha256: reference.sha256,
        engine_version: ENGINE_VERSION,
        supported_profile: "refused",
        findings: [],
        refusal_code: "unsupported_content",
      };
    }
    const findings = hiddenFindings(files["xl/workbook.xml"]!, files);
    return {
      version: "1",
      operation: "scan",
      status: findings.length === 0 ? "clean" : "findings",
      artifact_sha256: reference.sha256,
      engine_version: ENGINE_VERSION,
      supported_profile: "accepted",
      findings,
    };
  }

  verify(reference: ArtifactReference, originalArtifactSha256: string): EngineVerifyResult {
    const scan = this.scan(reference);
    const unchanged = reference.sha256 === originalArtifactSha256;
    if (scan.status !== "clean" || !unchanged) {
      return {
        version: "1",
        operation: "verify",
        status: "refused",
        artifact_sha256: reference.sha256,
        original_artifact_sha256: originalArtifactSha256,
        engine_version: ENGINE_VERSION,
        artifact_unchanged: unchanged,
        baseline_sha256: reference.sha256,
        remaining_findings: scan.findings,
        refusal_code: unchanged ? scan.refusal_code : "integrity_failure",
      };
    }
    return {
      version: "1",
      operation: "verify",
      status: "verified",
      artifact_sha256: reference.sha256,
      original_artifact_sha256: originalArtifactSha256,
      engine_version: ENGINE_VERSION,
      artifact_unchanged: true,
      baseline_sha256: reference.sha256,
      remaining_findings: [],
    };
  }
}
