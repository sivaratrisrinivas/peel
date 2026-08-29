import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type {
  ArtifactReference,
  DeliveryEvidence,
  EngineRepairResult,
  EngineScanResult,
  EngineVerifyResult,
  RepairEvidence,
  RepairPlan,
  RunState,
  ScanEvidence,
  ScopeAssessmentEvidence,
  VerificationEvidence,
} from "./contracts.js";

const ACTIVE_STATES = ["staged", "scanned", "verified", "awaiting_disclosure_approval", "disclosing"] as const;

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
  original_artifact: ArtifactReference;
  scan?: EngineScanResult;
  scope_assessment?: ScopeAssessmentEvidence;
  repair_plan?: RepairPlan;
  repair?: EngineRepairResult;
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
  kind: "repair" | "disclosure";
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
        original_artifact_json TEXT NOT NULL,
        scan_json TEXT,
        scope_assessment_json TEXT,
        repair_plan_json TEXT,
        repair_json TEXT,
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
        kind TEXT NOT NULL DEFAULT 'disclosure',
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
    const columns = this.database.prepare("PRAGMA table_info(runs)").all() as Array<Record<string, unknown>>;
    if (!columns.some((column) => column.name === "scope_assessment_json")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN scope_assessment_json TEXT");
    }
    if (!columns.some((column) => column.name === "original_artifact_json")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN original_artifact_json TEXT");
      this.database.exec("UPDATE runs SET original_artifact_json = artifact_json WHERE original_artifact_json IS NULL");
    }
    if (!columns.some((column) => column.name === "repair_plan_json")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN repair_plan_json TEXT");
    }
    if (!columns.some((column) => column.name === "repair_json")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN repair_json TEXT");
    }
    const authorizationColumns = this.database.prepare("PRAGMA table_info(authorizations)").all() as Array<Record<string, unknown>>;
    if (!authorizationColumns.some((column) => column.name === "kind")) {
      this.database.exec("ALTER TABLE authorizations ADD COLUMN kind TEXT NOT NULL DEFAULT 'disclosure'");
    }
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
        "UPDATE runs SET state = 'refused', updated_at = ? WHERE state = 'awaiting_repair_approval'",
      ).run(now);
      this.database.prepare(
        "UPDATE runs SET state = 'refused', artifact_json = original_artifact_json, repair_json = NULL, updated_at = ? WHERE state = 'repairing'",
      ).run(now);
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

  getActiveRuns(): StoredRun[] {
    const placeholders = ACTIVE_STATES.map(() => "?").join(", ");
    const rows = this.database.prepare(
      `SELECT * FROM runs WHERE state IN (${placeholders}) ORDER BY created_at ASC, run_id ASC`,
    ).all(...ACTIVE_STATES) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      const run = this.readRun(row);
      return run ? [run] : [];
    });
  }

  createRun(
    run: Omit<StoredRun, "scan" | "verification" | "delivery">,
    now: number,
  ): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.hasActiveRun()) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.database.prepare(`
        INSERT INTO runs (
          run_id, run_key, revision, state, envelope_revision_hash, body_sha256,
          sender, recipient, subject, artifact_json, original_artifact_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        JSON.stringify(run.original_artifact),
        now,
        now,
      );
      this.createRevision(run, now);
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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

  restoreArtifact(runId: string, revision: number, artifact: ArtifactReference, now: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.getRun(runId);
      if (
        !run ||
        run.revision !== revision ||
        run.artifact.sha256 !== artifact.sha256 ||
        run.artifact.filename !== artifact.filename ||
        run.artifact.byte_size !== artifact.byte_size
      ) {
        throw new Error("artifact restoration identity mismatch");
      }
      const originalArtifact = run.original_artifact.sha256 === run.artifact.sha256
        ? artifact
        : run.original_artifact;
      this.database.prepare(
        "UPDATE runs SET artifact_json = ?, original_artifact_json = ?, updated_at = ? WHERE run_id = ? AND revision = ?",
      ).run(JSON.stringify(artifact), JSON.stringify(originalArtifact), now, runId, revision);
      this.database.prepare(
        "UPDATE envelope_revisions SET attachment_json = ? WHERE run_id = ? AND revision = ?",
      ).run(JSON.stringify(artifact), runId, revision);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  reviseRun(
    runId: string,
    run: Omit<StoredRun, "scan" | "verification" | "delivery">,
    now: number,
  ): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.hasActiveRun(runId)) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.database.prepare(`
        UPDATE runs SET revision = ?, state = ?, envelope_revision_hash = ?, body_sha256 = ?,
          sender = ?, recipient = ?, subject = ?, artifact_json = ?, original_artifact_json = ?, scan_json = NULL,
          scope_assessment_json = NULL, repair_plan_json = NULL, repair_json = NULL,
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
        JSON.stringify(run.original_artifact),
        now,
        runId,
      );
      this.createRevision(run, now);
      this.database.prepare(
        "UPDATE authorizations SET status = 'invalidated' WHERE run_id = ? AND status = 'pending'",
      ).run(runId);
      this.database.exec("COMMIT");
      return true;
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
    scopeAssessment?: ScopeAssessmentEvidence,
  ): void {
    const current = this.getRun(runId);
    if (!current) throw new Error("run not found");
    this.database.prepare(`
      UPDATE runs SET state = ?, scan_json = ?, scope_assessment_json = ?, repair_plan_json = ?, verification_json = ?, delivery_json = ?, updated_at = ?
      WHERE run_id = ?
    `).run(
      state,
      scan ? JSON.stringify(scan) : current.scan ? JSON.stringify(current.scan) : null,
      scopeAssessment
        ? JSON.stringify(scopeAssessment)
        : current.scope_assessment
          ? JSON.stringify(current.scope_assessment)
          : null,
      scan?.repair_plan
        ? JSON.stringify(scan.repair_plan)
        : current.repair_plan
          ? JSON.stringify(current.repair_plan)
          : null,
      verification ? JSON.stringify(verification) : current.verification ? JSON.stringify(current.verification) : null,
      delivery ? JSON.stringify(delivery) : current.delivery ? JSON.stringify(current.delivery) : null,
      now,
      runId,
    );
  }

  setRepairCandidate(
    runId: string,
    candidate: ArtifactReference,
    plan: RepairPlan,
    repair: EngineRepairResult,
    now: number,
  ): void {
    this.database.prepare(`
      UPDATE runs SET artifact_json = ?, repair_plan_json = ?, repair_json = ?, state = 'scanned', updated_at = ?
      WHERE run_id = ?
    `).run(JSON.stringify(candidate), JSON.stringify(plan), JSON.stringify(repair), now, runId);
  }

  restoreOriginalAndRefuse(runId: string, verification: EngineVerifyResult | undefined, now: number): void {
    const current = this.getRun(runId);
    if (!current) throw new Error("run not found");
    this.database.prepare(`
      UPDATE runs SET artifact_json = ?, repair_json = NULL, verification_json = ?, state = 'refused', updated_at = ?
      WHERE run_id = ?
    `).run(
      JSON.stringify(current.original_artifact),
      verification ? JSON.stringify(verification) : current.verification ? JSON.stringify(current.verification) : null,
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
    kind: StoredAuthorization["kind"] = "disclosure",
  ): void {
    this.database.prepare(`
      INSERT INTO authorizations (
        approval_id, run_id, revision, idempotency_key, kind, expires_at, status, binding_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(approvalId, runId, revision, idempotencyKey, kind, expiresAt, bindingJson, now);
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
      kind: requiredString(record, "kind") as StoredAuthorization["kind"],
    };
  }

  getPendingAuthorization(runId: string, kind: StoredAuthorization["kind"]): StoredAuthorization | undefined {
    const row = this.database.prepare(
      "SELECT * FROM authorizations WHERE run_id = ? AND kind = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    ).get(runId, kind);
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
      kind: requiredString(record, "kind") as StoredAuthorization["kind"],
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
      original_artifact: JSON.parse(requiredString(record, "original_artifact_json")) as ArtifactReference,
      scan: optionalJson<EngineScanResult>(record, "scan_json"),
      scope_assessment: optionalJson<ScopeAssessmentEvidence>(record, "scope_assessment_json"),
      repair_plan: optionalJson<RepairPlan>(record, "repair_plan_json"),
      repair: optionalJson<EngineRepairResult>(record, "repair_json"),
      verification: optionalJson<EngineVerifyResult>(record, "verification_json"),
      delivery: optionalJson<DeliveryEvidence>(record, "delivery_json"),
    };
  }

  private hasActiveRun(excludeRunId?: string): boolean {
    const placeholders = ACTIVE_STATES.map(() => "?").join(", ");
    const query = excludeRunId === undefined
      ? `SELECT 1 AS found FROM runs WHERE state IN (${placeholders}) LIMIT 1`
      : `SELECT 1 AS found FROM runs WHERE state IN (${placeholders}) AND run_id <> ? LIMIT 1`;
    const parameters = excludeRunId === undefined ? [...ACTIVE_STATES] : [...ACTIVE_STATES, excludeRunId];
    return Boolean(this.database.prepare(query).get(...parameters));
  }
}

export function toScanEvidence(scan: EngineScanResult): ScanEvidence {
  const evidence: ScanEvidence = {
    status: scan.status,
    artifact_sha256: scan.artifact_sha256,
    engine_version: scan.engine_version,
    finding_count: scan.findings.length,
    findings: scan.findings,
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

export function toRepairEvidence(repair: EngineRepairResult): RepairEvidence {
  return {
    original_artifact_sha256: repair.original_artifact_sha256,
    artifact_sha256: repair.artifact_sha256,
    repair_plan_sha256: repair.repair_plan_sha256,
    engine_version: repair.engine_version,
    changed_members: repair.changed_members,
  };
}
