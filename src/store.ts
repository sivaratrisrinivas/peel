import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type {
  ArtifactReference,
  DeliveryEvidence,
  EngineScanResult,
  EngineVerifyResult,
  RunState,
  ScanEvidence,
  VerificationEvidence,
} from "./contracts.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface StoredRun {
  run_id: string;
  run_key: string;
  revision: number;
  state: RunState;
  envelope_revision_hash: string;
  body_sha256: string;
  sender: string;
  recipient: string;
  subject: string;
  artifact: ArtifactReference;
  scan?: EngineScanResult;
  verification?: EngineVerifyResult;
  delivery?: DeliveryEvidence;
}

export interface StoredAuthorization {
  approval_id: string;
  run_id: string;
  revision: number;
  idempotency_key: string;
  expires_at: number;
  status: "pending" | "consumed" | "denied" | "expired" | "invalidated";
  binding_json: string;
}

export interface StoredCommand {
  command_id: string;
  request_hash: string;
  response_json: string;
}

export interface StoredDeliveryAttempt {
  attempt_id: string;
  run_id: string;
  revision: number;
  idempotency_key: string;
  disclosure_fingerprint: string;
  status: DeliveryEvidence["status"];
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`database field ${key} is invalid`);
  return value;
}

function optionalJson<T>(row: Record<string, unknown>, key: string): T | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`database field ${key} is invalid`);
  return JSON.parse(value) as T;
}

function integerField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`database field ${key} is invalid`);
  return value;
}

export class RunStore {
  private readonly database: DatabaseSyncType;

  constructor(path = ":memory:") {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        run_key TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        envelope_revision_hash TEXT NOT NULL,
        body_sha256 TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        scan_json TEXT,
        verification_json TEXT,
        delivery_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS envelope_revisions (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        revision INTEGER NOT NULL,
        envelope_revision_hash TEXT NOT NULL,
        body_sha256 TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        attachment_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, revision)
      );
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authorizations (
        approval_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        revision INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS disclosure_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        revision INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        disclosure_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS disclosure_fingerprint_idx
        ON disclosure_attempts(disclosure_fingerprint, status);
    `);
  }

  recoverAfterRestart(now: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "UPDATE authorizations SET status = 'invalidated' WHERE status = 'pending'",
      ).run();
      this.database.prepare(`
        UPDATE runs SET state = 'verified', updated_at = ?
        WHERE state = 'awaiting_disclosure_approval'
      `).run(now);
      this.database.prepare(
        "UPDATE runs SET state = 'failed', updated_at = ? WHERE state = 'disclosing'",
      ).run(now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  findRunByKey(runKey: string): StoredRun | undefined {
    return this.readRun(
      this.database.prepare("SELECT * FROM runs WHERE run_key = ?").get(runKey),
    );
  }

  getRun(runId: string): StoredRun | undefined {
    return this.readRun(
      this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId),
    );
  }

  createRun(
    run: Omit<StoredRun, "scan" | "verification" | "delivery">,
    now: number,
  ): void {
    this.database.prepare(`
      INSERT INTO runs (
        run_id, run_key, revision, state, envelope_revision_hash, body_sha256,
        sender, recipient, subject, artifact_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.run_id,
      run.run_key,
      run.revision,
      run.state,
      run.envelope_revision_hash,
      run.body_sha256,
      run.sender,
      run.recipient,
      run.subject,
      JSON.stringify(run.artifact),
      now,
      now,
    );
    this.createRevision(run, now);
  }

  createRevision(run: Omit<StoredRun, "scan" | "verification" | "delivery">, now: number): void {
    this.database.prepare(`
      INSERT INTO envelope_revisions (
        run_id, revision, envelope_revision_hash, body_sha256, sender, recipient,
        subject, attachment_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.run_id,
      run.revision,
      run.envelope_revision_hash,
      run.body_sha256,
      run.sender,
      run.recipient,
      run.subject,
      JSON.stringify(run.artifact),
      now,
    );
  }

  reviseRun(
    runId: string,
    run: Omit<StoredRun, "scan" | "verification" | "delivery">,
    now: number,
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE runs SET revision = ?, state = ?, envelope_revision_hash = ?, body_sha256 = ?,
          sender = ?, recipient = ?, subject = ?, artifact_json = ?, scan_json = NULL,
          verification_json = NULL, delivery_json = NULL, updated_at = ? WHERE run_id = ?
      `).run(
        run.revision,
        "staged",
        run.envelope_revision_hash,
        run.body_sha256,
        run.sender,
        run.recipient,
        run.subject,
        JSON.stringify(run.artifact),
        now,
        runId,
      );
      this.createRevision(run, now);
      this.database.prepare(
        "UPDATE authorizations SET status = 'invalidated' WHERE run_id = ? AND status = 'pending'",
      ).run(runId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  setState(
    runId: string,
    state: RunState,
    now: number,
    scan?: EngineScanResult,
    verification?: EngineVerifyResult,
    delivery?: DeliveryEvidence,
  ): void {
    const current = this.getRun(runId);
    if (!current) throw new Error("run not found");
    this.database.prepare(`
      UPDATE runs SET state = ?, scan_json = ?, verification_json = ?, delivery_json = ?, updated_at = ?
      WHERE run_id = ?
    `).run(
      state,
      scan ? JSON.stringify(scan) : current.scan ? JSON.stringify(current.scan) : null,
      verification ? JSON.stringify(verification) : current.verification ? JSON.stringify(current.verification) : null,
      delivery ? JSON.stringify(delivery) : current.delivery ? JSON.stringify(current.delivery) : null,
      now,
      runId,
    );
  }

  getCommand(commandId: string): StoredCommand | undefined {
    const row = this.database.prepare("SELECT command_id, request_hash, response_json FROM commands WHERE command_id = ?").get(commandId);
    if (!row) return undefined;
    const record = row as Record<string, unknown>;
    return {
      command_id: requiredString(record, "command_id"),
      request_hash: requiredString(record, "request_hash"),
      response_json: requiredString(record, "response_json"),
    };
  }

  saveCommand(commandId: string, requestHash: string, responseJson: string, now: number): void {
    this.database.prepare(
      "INSERT INTO commands (command_id, request_hash, response_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(commandId, requestHash, responseJson, now);
  }

  createAuthorization(
    approvalId: string,
    runId: string,
    revision: number,
    idempotencyKey: string,
    expiresAt: number,
    bindingJson: string,
    now: number,
  ): void {
    this.database.prepare(`
      INSERT INTO authorizations (
        approval_id, run_id, revision, idempotency_key, expires_at, status, binding_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(approvalId, runId, revision, idempotencyKey, expiresAt, bindingJson, now);
  }

  getAuthorization(approvalId: string): StoredAuthorization | undefined {
    const row = this.database.prepare("SELECT * FROM authorizations WHERE approval_id = ?").get(approvalId);
    if (!row) return undefined;
    const record = row as Record<string, unknown>;
    return {
      approval_id: requiredString(record, "approval_id"),
      run_id: requiredString(record, "run_id"),
      revision: integerField(record, "revision"),
      idempotency_key: requiredString(record, "idempotency_key"),
      expires_at: integerField(record, "expires_at"),
      status: requiredString(record, "status") as StoredAuthorization["status"],
      binding_json: requiredString(record, "binding_json"),
    };
  }

  setAuthorizationStatus(approvalId: string, status: StoredAuthorization["status"]): void {
    this.database.prepare("UPDATE authorizations SET status = ? WHERE approval_id = ?").run(status, approvalId);
  }

  addDisclosureAttempt(attempt: StoredDeliveryAttempt, now: number): void {
    this.database.prepare(`
      INSERT INTO disclosure_attempts (
        attempt_id, run_id, revision, idempotency_key, disclosure_fingerprint, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.attempt_id,
      attempt.run_id,
      attempt.revision,
      attempt.idempotency_key,
      attempt.disclosure_fingerprint,
      attempt.status,
      now,
    );
  }

  hasSuccessfulDisclosure(fingerprint: string): boolean {
    const row = this.database.prepare(
      "SELECT 1 AS found FROM disclosure_attempts WHERE disclosure_fingerprint = ? AND status = 'accepted' LIMIT 1",
    ).get(fingerprint);
    return Boolean(row);
  }

  private readRun(row: unknown): StoredRun | undefined {
    if (!row) return undefined;
    const record = row as Record<string, unknown>;
    const state = requiredString(record, "state") as RunState;
    const artifactJson = requiredString(record, "artifact_json");
    return {
      run_id: requiredString(record, "run_id"),
      run_key: requiredString(record, "run_key"),
      revision: integerField(record, "revision"),
      state,
      envelope_revision_hash: requiredString(record, "envelope_revision_hash"),
      body_sha256: requiredString(record, "body_sha256"),
      sender: requiredString(record, "sender"),
      recipient: requiredString(record, "recipient"),
      subject: requiredString(record, "subject"),
      artifact: JSON.parse(artifactJson) as ArtifactReference,
      scan: optionalJson<EngineScanResult>(record, "scan_json"),
      verification: optionalJson<EngineVerifyResult>(record, "verification_json"),
      delivery: optionalJson<DeliveryEvidence>(record, "delivery_json"),
    };
  }
}

export function toScanEvidence(scan: EngineScanResult): ScanEvidence {
  const evidence: ScanEvidence = {
    status: scan.status,
    artifact_sha256: scan.artifact_sha256,
    engine_version: scan.engine_version,
    finding_count: scan.findings.length,
    supported_profile: scan.supported_profile,
  };
  if (scan.refusal_code) evidence.refusal_code = scan.refusal_code;
  return evidence;
}

export function toVerificationEvidence(verification: EngineVerifyResult): VerificationEvidence {
  const evidence: VerificationEvidence = {
    status: verification.status,
    artifact_sha256: verification.artifact_sha256,
    engine_version: verification.engine_version,
    artifact_unchanged: verification.artifact_unchanged,
    baseline_sha256: verification.baseline_sha256,
    remaining_finding_count: verification.remaining_findings.length,
  };
  if (verification.refusal_code) evidence.refusal_code = verification.refusal_code;
  return evidence;
}
