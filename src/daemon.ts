import {
  API_VERSION,
  ENGINE_VERSION,
  REVEAL_TTL_MS,
  type ApiResponse,
  type ArtifactReference,
  type Clock,
  type Command,
  type DisclosureBinding,
  type Envelope,
  type ErrorResponse,
  type EngineRepairResult,
  type EngineScanResult,
  type EngineVerifyResult,
  type RevealReference,
  type RevealRow,
  type RevealSample,
  type RunView,
  type ScopeAssessmentEvidence,
  type ScopeAssessor,
  type RepairApprovalView,
  type RepairPlan,
  type SuccessResponse,
} from "./contracts.js";
import {
  ArtifactError,
  FakeDisclosureMailer,
  FakeWorkbookEngine,
  InMemoryArtifactStore,
  SystemClock,
  UnavailableScopeAssessor,
} from "./adapters.js";
import { disclosureBinding, disclosureFingerprint, envelopeRevisionHash, newId, repairApprovalBinding, repairPlanHash, runKey, sha256, canonicalJson } from "./identity.js";
import { RunStore, toRepairEvidence, toScanEvidence, toVerificationEvidence, type StoredRun } from "./store.js";
import {
  parseCommand,
  parseEngineRepairResult,
  parseEngineScanResult,
  parseEngineVerifyResult,
  parseScopeAssessmentResult,
  SchemaError,
} from "./schema.js";
import type {
  ArtifactStore,
  DisclosureMailer,
  EngineAdapter,
  DeliveryOutcome,
  Finding,
  RunState,
} from "./contracts.js";

interface InMemoryEnvelope {
  runId: string;
  revision: number;
  envelope: Envelope;
}

interface EphemeralReveal {
  reference: RevealReference;
  artifact_sha256: string;
  rows: RevealRow[];
}

export interface PeelDaemonOptions {
  allowedRecipients: readonly string[];
  artifactStore?: ArtifactStore;
  clock?: Clock;
  disclosureMailer?: DisclosureMailer;
  engine?: EngineAdapter;
  scopeAssessor?: ScopeAssessor;
  revealEnabled?: boolean;
  databasePath?: string;
}

class CommandFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CommandFailure";
    this.code = code;
  }
}

function isoTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function parseClaimedScope(body: string): string {
  const fields = body
    .split(/\r?\n/)
    .filter((line) => /^\s*Intended disclosure\s*:/i.test(line))
    .map((line) => line.replace(/^\s*Intended disclosure\s*:/i, "").trim());
  if (fields.length !== 1 || fields[0]!.length === 0) throw new CommandFailure("insufficient_context");
  return fields[0]!;
}

function artifactFailureCode(error: unknown): string {
  if (error instanceof ArtifactError) {
    if (error.code === "expired_artifact") return "artifact_expired";
    if (error.code === "undeclared_artifact") return "artifact_undeclared";
  }
  return "artifact_integrity_failure";
}

function publicRun(run: StoredRun, reveals: readonly RevealReference[] = []): RunView {
  const view: RunView = {
    run_id: run.run_id,
    revision: run.revision,
    state: run.state,
    envelope_revision_hash: run.envelope_revision_hash,
    artifact: run.artifact,
    original_artifact: run.original_artifact,
  };
  if (run.scan) view.scan = toScanEvidence(run.scan);
  if (run.scope_assessment) view.scope_assessment = run.scope_assessment;
  if (run.repair_plan) view.repair_plan = run.repair_plan;
  if (run.repair) view.repair = toRepairEvidence(run.repair);
  if (reveals.length > 0) view.reveals = [...reveals];
  if (run.verification) view.verification = toVerificationEvidence(run.verification);
  if (run.delivery) view.delivery = run.delivery;
  return view;
}

function success(
  run: StoredRun,
  extra: Pick<SuccessResponse, "approval" | "repair_approval" | "deduplicated"> = {},
  reveals: readonly RevealReference[] = [],
): SuccessResponse {
  const response: SuccessResponse = { version: API_VERSION, ok: true, run: publicRun(run, reveals) };
  if (extra.approval) response.approval = extra.approval;
  if (extra.repair_approval) response.repair_approval = extra.repair_approval;
  if (extra.deduplicated !== undefined) response.deduplicated = extra.deduplicated;
  return response;
}

export class PeelDaemon {
  readonly artifactStore: ArtifactStore;
  readonly disclosureMailer: DisclosureMailer;

  private readonly clock: Clock;
  private readonly engine: EngineAdapter;
  private readonly scopeAssessor: ScopeAssessor;
  private readonly store: RunStore;
  private readonly allowedRecipients: ReadonlySet<string>;
  private readonly envelopes = new Map<string, InMemoryEnvelope>();
  private readonly reveals = new Map<string, EphemeralReveal>();
  private readonly revealTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly revealEnabled: boolean;

  constructor(options: PeelDaemonOptions) {
    if (options.allowedRecipients.length === 0) throw new Error("at least one allowed recipient is required");
    this.clock = options.clock ?? new SystemClock();
    this.artifactStore = options.artifactStore ?? new InMemoryArtifactStore(this.clock);
    this.disclosureMailer = options.disclosureMailer ?? new FakeDisclosureMailer();
    this.engine = options.engine ?? new FakeWorkbookEngine(this.artifactStore);
    this.scopeAssessor = options.scopeAssessor ?? new UnavailableScopeAssessor();
    this.store = new RunStore(options.databasePath ?? ":memory:");
    this.store.recoverAfterRestart(this.clock.now());
    this.allowedRecipients = new Set(options.allowedRecipients.map((recipient) => recipient.toLowerCase()));
    this.revealEnabled = options.revealEnabled === true;
  }

  close(): void {
    this.reveals.clear();
    for (const timer of this.revealTimers.values()) clearTimeout(timer);
    this.revealTimers.clear();
    this.store.close();
  }

  getRun(runId: string): RunView | undefined {
    const run = this.store.getRun(runId);
    return run ? publicRun(run, this.revealReferencesForRun(run)) : undefined;
  }

  uploadArtifact(bytes: Uint8Array, filename: string, ttlMs?: number): ArtifactReference {
    return this.artifactStore.put(bytes, filename, ttlMs);
  }

  async execute(input: unknown): Promise<ApiResponse> {
    let command: Command;
    try {
      command = parseCommand(input);
    } catch (error) {
      return this.error(error instanceof SchemaError ? error.code : "invalid_schema");
    }

    const requestHash = sha256(canonicalJson(command));
    const previous = this.store.getCommand(command.command_id);
    if (previous) {
      if (previous.request_hash !== requestHash) return this.error("command_replay_conflict");
      return this.refreshCachedResponse(JSON.parse(previous.response_json) as ApiResponse);
    }

    let response: ApiResponse;
    try {
      response = this.dispatch(command);
    } catch (error) {
      const run = "run_id" in command && typeof command.run_id === "string" ? this.store.getRun(command.run_id) : undefined;
      response = this.error(error instanceof CommandFailure ? error.code : "command_failed", run);
    }
    this.store.saveCommand(command.command_id, requestHash, JSON.stringify(response), this.clock.now());
    return response;
  }

  private dispatch(command: Command): ApiResponse {
    switch (command.command) {
      case "stage":
        return this.stage(command);
      case "scan":
        return this.scan(command);
      case "apply_repair":
        return this.applyRepair(command);
      case "verify":
        return this.verify(command);
      case "request_disclosure":
        return this.requestDisclosure(command);
      case "respond_disclosure":
        return this.respondDisclosure(command);
    }
  }

  private stage(command: Extract<Command, { command: "stage" }>): ApiResponse {
    const { envelope, trigger } = command;
    parseClaimedScope(envelope.body);
    if (!this.allowedRecipients.has(envelope.recipient.toLowerCase())) throw new CommandFailure("recipient_not_allowed");
    if (envelope.attachment.byte_size > 10 * 1024 * 1024) throw new CommandFailure("artifact_too_large");
    try {
      this.artifactStore.read(envelope.attachment);
    } catch (error) {
      throw new CommandFailure(artifactFailureCode(error));
    }

    const key = runKey(trigger);
    const revisionHash = envelopeRevisionHash(envelope);
    const current = this.store.findRunByKey(key);
    if (current) {
      if (current.state === "disclosed" && current.envelope_revision_hash !== revisionHash) {
        throw new CommandFailure("run_already_disclosed");
      }
      if (current.envelope_revision_hash === revisionHash) {
        this.envelopes.set(current.run_id, {
          runId: current.run_id,
          revision: current.revision,
          envelope: { ...envelope, attachment: current.artifact },
        });
        return success(current, { deduplicated: true });
      }
      const revised: Omit<StoredRun, "scan" | "verification" | "delivery"> = {
        ...current,
        revision: current.revision + 1,
        state: "staged",
        envelope_revision_hash: revisionHash,
        body_sha256: sha256(envelope.body),
        sender: envelope.sender,
        recipient: envelope.recipient,
        subject: envelope.subject,
        artifact: envelope.attachment,
        original_artifact: envelope.attachment,
      };
      this.store.reviseRun(current.run_id, revised, this.clock.now());
      this.clearReveals(current.run_id);
      this.envelopes.set(current.run_id, { runId: current.run_id, revision: revised.revision, envelope });
      return success(this.mustGetRun(current.run_id));
    }

    const run: Omit<StoredRun, "scan" | "verification" | "delivery"> = {
      run_id: newId(),
      run_key: key,
      revision: 1,
      state: "staged",
      envelope_revision_hash: revisionHash,
      body_sha256: sha256(envelope.body),
      sender: envelope.sender,
      recipient: envelope.recipient,
      subject: envelope.subject,
      artifact: envelope.attachment,
      original_artifact: envelope.attachment,
    };
    this.store.createRun(run, this.clock.now());
    this.envelopes.set(run.run_id, { runId: run.run_id, revision: run.revision, envelope });
    return success(this.mustGetRun(run.run_id));
  }

  private scan(command: Extract<Command, { command: "scan" }>): ApiResponse {
    const run = this.authorizedRun(command.run_id, command.revision, command.artifact_sha256, "staged");
    try {
      this.artifactStore.read(run.artifact);
    } catch (error) {
      this.discardCandidate(run);
      return this.error(artifactFailureCode(error), this.mustGetRun(run.run_id));
    }
    let result: EngineScanResult;
    try {
      result = parseEngineScanResult(this.engine.scan(run.artifact));
    } catch (error) {
      this.store.setState(run.run_id, "refused", this.clock.now());
      return this.error(error instanceof SchemaError ? "invalid_engine_result" : "engine_failed", this.mustGetRun(run.run_id));
    }
    if (result.artifact_sha256 !== run.artifact.sha256) {
      this.store.setState(run.run_id, "refused", this.clock.now(), result);
      return this.error("artifact_identity_mismatch", this.mustGetRun(run.run_id));
    }
    if (result.status === "clean") {
      this.store.setState(run.run_id, "scanned", this.clock.now(), result);
      return success(this.mustGetRun(run.run_id));
    }
    if (result.status === "refused") {
      this.store.setState(run.run_id, "refused", this.clock.now(), result);
      return success(this.mustGetRun(run.run_id));
    }

    let scopeAssessment: ScopeAssessmentEvidence;
    const heldEnvelope = this.envelopes.get(run.run_id);
    if (!heldEnvelope || heldEnvelope.revision !== run.revision) {
      scopeAssessment = { status: "insufficient_context" };
    } else {
      try {
        const claimedScope = parseClaimedScope(heldEnvelope.envelope.body);
        const assessed = parseScopeAssessmentResult(this.scopeAssessor.assess({
          claimed_scope: claimedScope,
          findings: result.findings,
        }));
        scopeAssessment = { status: assessed.status };
      } catch {
        this.store.setState(run.run_id, "refused", this.clock.now(), result);
        return this.error("scope_assessment_failed", this.mustGetRun(run.run_id));
      }
    }

    if (scopeAssessment.status === "mismatch") {
      this.store.setState(run.run_id, "refused", this.clock.now(), result, undefined, undefined, scopeAssessment);
      return this.error("scope_mismatch", this.mustGetRun(run.run_id));
    }
    if (scopeAssessment.status === "insufficient_context") {
      this.store.setState(run.run_id, "refused", this.clock.now(), result, undefined, undefined, scopeAssessment);
      return this.error("scope_insufficient_context", this.mustGetRun(run.run_id));
    }
    const plan = result.repair_plan;
    if (!plan) {
      this.store.setState(run.run_id, "refused", this.clock.now(), result, undefined, undefined, scopeAssessment);
      return this.error("repair_plan_unavailable", this.mustGetRun(run.run_id));
    }
    if (plan.artifact_sha256 !== run.artifact.sha256) {
      this.store.setState(run.run_id, "refused", this.clock.now(), result, undefined, undefined, scopeAssessment);
      return this.error("repair_plan_identity_mismatch", this.mustGetRun(run.run_id));
    }
    if (plan.engine_version !== result.engine_version) {
      this.store.setState(run.run_id, "refused", this.clock.now(), result, undefined, undefined, scopeAssessment);
      return this.error("repair_plan_identity_mismatch", this.mustGetRun(run.run_id));
    }
    const refusedPlan = plan.status === "refused";
    if (refusedPlan) {
      this.store.setState(run.run_id, "refused", this.clock.now(), result, undefined, undefined, scopeAssessment);
      return this.error("repair_refused", this.mustGetRun(run.run_id));
    }
    const approvalId = newId();
    const idempotencyKey = newId();
    const binding = repairApprovalBinding(run.run_id, run.revision, run.artifact.sha256, plan);
    const expiresAt = this.clock.now() + 5 * 60 * 1000;
    this.store.createAuthorization(
      approvalId,
      run.run_id,
      run.revision,
      idempotencyKey,
      expiresAt,
      JSON.stringify(binding),
      this.clock.now(),
      "repair",
    );
    this.store.setState(run.run_id, "awaiting_repair_approval", this.clock.now(), result, undefined, undefined, scopeAssessment);
    const approval: RepairApprovalView = {
      approval_id: approvalId,
      expires_at: isoTime(expiresAt),
      idempotency_key: idempotencyKey,
      binding,
    };
    const awaiting = this.mustGetRun(run.run_id);
    this.prepareReveals(awaiting, result.findings);
    return success(this.mustGetRun(run.run_id), { repair_approval: approval }, this.revealReferencesForRun(awaiting));
  }

  private verify(command: Extract<Command, { command: "verify" }>): ApiResponse {
    const run = this.authorizedRun(command.run_id, command.revision, command.artifact_sha256, "scanned");
    try {
      this.artifactStore.read(run.artifact);
    } catch (error) {
      this.discardCandidate(run);
      return this.error(artifactFailureCode(error), this.mustGetRun(run.run_id));
    }
    let result: EngineVerifyResult;
    try {
      result = parseEngineVerifyResult(this.engine.verify(run.artifact, run.original_artifact.sha256, run.repair_plan, run.original_artifact));
    } catch (error) {
      this.discardCandidate(run);
      return this.error(error instanceof SchemaError ? "invalid_engine_result" : "engine_failed", this.mustGetRun(run.run_id));
    }
    if (result.artifact_sha256 !== run.artifact.sha256 || result.original_artifact_sha256 !== run.original_artifact.sha256) {
      this.discardCandidate(run);
      return this.error("artifact_identity_mismatch", this.mustGetRun(run.run_id));
    }
    if (
      run.repair_plan &&
      (result.relationships_valid !== true || result.content_types_valid !== true ||
        !result.reopened_with || result.reopened_with.length === 0 ||
        result.artifact_unchanged !== true ||
        result.unexplained_changes === undefined || result.unexplained_changes.length > 0)
    ) {
      this.discardCandidate(run, result);
      return this.error("verification_failed", this.mustGetRun(run.run_id));
    }
    const nextState: RunState = result.status === "verified" ? "verified" : "refused";
    if (nextState === "refused") {
      this.discardCandidate(run, result);
      return this.error("verification_failed", this.mustGetRun(run.run_id));
    }
    this.store.setState(run.run_id, nextState, this.clock.now(), run.scan, result);
    return success(this.mustGetRun(run.run_id));
  }

  private applyRepair(command: Extract<Command, { command: "apply_repair" }>): ApiResponse {
    const run = this.authorizedRun(command.run_id, command.revision, command.artifact_sha256, "awaiting_repair_approval");
    const plan = run.repair_plan;
    if (!plan || plan.status !== "eligible") throw new CommandFailure("repair_plan_unavailable");
    const authorization = this.store.getAuthorization(command.approval_id);
    if (!authorization) throw new CommandFailure("authorization_not_found");
    if (
      authorization.kind !== "repair" ||
      authorization.run_id !== run.run_id ||
      authorization.revision !== run.revision ||
      authorization.idempotency_key !== command.idempotency_key ||
      canonicalJson(JSON.parse(authorization.binding_json)) !== canonicalJson(command.binding)
    ) {
      throw new CommandFailure("authorization_binding_mismatch");
    }
    const expectedBinding = repairApprovalBinding(run.run_id, run.revision, run.original_artifact.sha256, plan);
    if (canonicalJson(expectedBinding) !== canonicalJson(command.binding)) throw new CommandFailure("stale_identity");
    if (authorization.status !== "pending") throw new CommandFailure("authorization_not_pending");
    if (this.clock.now() >= authorization.expires_at) {
      this.store.setAuthorizationStatus(authorization.approval_id, "expired");
      this.store.setState(run.run_id, "refused", this.clock.now());
      return this.error("authorization_expired", this.mustGetRun(run.run_id));
    }
    this.store.setAuthorizationStatus(authorization.approval_id, "consumed");
    this.store.setState(run.run_id, "repairing", this.clock.now());
    let result: EngineRepairResult;
    try {
      if (!this.engine.repair) throw new Error("repair is unavailable");
      result = parseEngineRepairResult(this.engine.repair(run.original_artifact, plan));
    } catch {
      this.store.restoreOriginalAndRefuse(run.run_id, undefined, this.clock.now());
      return this.error("repair_failed", this.mustGetRun(run.run_id));
    }
    const candidate = result.candidate_artifact;
    const changedMembersMatch = canonicalJson(result.changed_members) === canonicalJson(plan.changed_members);
    if (
      result.status !== "repaired" ||
      !candidate ||
      result.original_artifact_sha256 !== run.original_artifact.sha256 ||
      result.repair_plan_sha256 !== repairPlanHash(plan) ||
      result.engine_version !== plan.engine_version ||
      result.artifact_sha256 !== candidate.sha256 ||
      candidate.sha256 === run.original_artifact.sha256 ||
      !changedMembersMatch
    ) {
      this.discardArtifact(candidate, run.original_artifact);
      this.store.restoreOriginalAndRefuse(run.run_id, undefined, this.clock.now());
      return this.error("repair_failed", this.mustGetRun(run.run_id));
    }
    try {
      this.artifactStore.read(candidate);
    } catch {
      this.discardArtifact(candidate, run.original_artifact);
      this.store.restoreOriginalAndRefuse(run.run_id, undefined, this.clock.now());
      return this.error("repair_failed", this.mustGetRun(run.run_id));
    }
    this.store.setRepairCandidate(run.run_id, candidate, plan, result, this.clock.now());
    const heldEnvelope = this.envelopes.get(run.run_id);
    if (heldEnvelope && heldEnvelope.revision === run.revision) {
      this.envelopes.set(run.run_id, { ...heldEnvelope, envelope: { ...heldEnvelope.envelope, attachment: candidate } });
    }
    return success(this.mustGetRun(run.run_id));
  }

  private requestDisclosure(command: Extract<Command, { command: "request_disclosure" }>): ApiResponse {
    const run = this.authorizedRun(command.run_id, command.revision, command.artifact_sha256, "verified");
    try {
      this.artifactStore.read(run.artifact);
    } catch (error) {
      this.store.setState(run.run_id, "refused", this.clock.now());
      return this.error(artifactFailureCode(error), this.mustGetRun(run.run_id));
    }
    const heldEnvelope = this.envelopes.get(run.run_id);
    if (!heldEnvelope || heldEnvelope.revision !== run.revision) throw new CommandFailure("envelope_unavailable");
    const approvalId = newId();
    const idempotencyKey = newId();
    const binding = disclosureBinding(
      run.run_id,
      run.revision,
      run.envelope_revision_hash,
      run.artifact.sha256,
      heldEnvelope.envelope,
    );
    const expiresAt = this.clock.now() + 5 * 60 * 1000;
    this.store.createAuthorization(
      approvalId,
      run.run_id,
      run.revision,
      idempotencyKey,
      expiresAt,
      JSON.stringify(binding),
      this.clock.now(),
    );
    this.store.setState(run.run_id, "awaiting_disclosure_approval", this.clock.now());
    return success(this.mustGetRun(run.run_id), {
      approval: {
        approval_id: approvalId,
        expires_at: isoTime(expiresAt),
        idempotency_key: idempotencyKey,
        binding,
      },
    });
  }

  private respondDisclosure(command: Extract<Command, { command: "respond_disclosure" }>): ApiResponse {
    const existing = this.store.getRun(command.run_id);
    if (
      existing &&
      existing.revision === command.revision &&
      existing.artifact.sha256 === command.artifact_sha256 &&
      existing.state === "disclosed"
    ) {
      throw new CommandFailure("duplicate_disclosure");
    }
    const run = this.authorizedRun(command.run_id, command.revision, command.artifact_sha256, "awaiting_disclosure_approval");
    const authorization = this.store.getAuthorization(command.approval_id);
    if (!authorization) throw new CommandFailure("authorization_not_found");
    if (
      authorization.run_id !== run.run_id ||
      authorization.revision !== run.revision ||
      authorization.idempotency_key !== command.idempotency_key ||
      canonicalJson(JSON.parse(authorization.binding_json)) !== canonicalJson(command.binding)
    ) {
      throw new CommandFailure("authorization_binding_mismatch");
    }
    if (authorization.status !== "pending") throw new CommandFailure("authorization_not_pending");
    if (this.clock.now() >= authorization.expires_at) {
      this.store.setAuthorizationStatus(authorization.approval_id, "expired");
      this.store.setState(run.run_id, "verified", this.clock.now());
      return this.error("authorization_expired", this.mustGetRun(run.run_id));
    }
    const heldEnvelope = this.envelopes.get(run.run_id);
    if (!heldEnvelope || heldEnvelope.revision !== run.revision) throw new CommandFailure("envelope_unavailable");
    const fingerprint = disclosureFingerprint(run.artifact.sha256, heldEnvelope.envelope);
    const attemptId = newId();
    if (command.decision === "deny") {
      this.store.setAuthorizationStatus(authorization.approval_id, "denied");
      this.store.addDisclosureAttempt({
        attempt_id: attemptId,
        run_id: run.run_id,
        revision: run.revision,
        idempotency_key: command.idempotency_key,
        disclosure_fingerprint: fingerprint,
        status: "denied",
      }, this.clock.now());
      this.store.setState(run.run_id, "verified", this.clock.now(), undefined, undefined, {
        attempt_id: attemptId,
        idempotency_key: command.idempotency_key,
        status: "denied",
        disclosure_fingerprint: fingerprint,
      });
      return success(this.mustGetRun(run.run_id));
    }

    if (this.store.hasSuccessfulDisclosure(fingerprint)) throw new CommandFailure("duplicate_disclosure");
    let bytes: Uint8Array;
    try {
      bytes = this.artifactStore.read(run.artifact);
    } catch (error) {
      this.store.setAuthorizationStatus(authorization.approval_id, "consumed");
      this.store.setState(run.run_id, "refused", this.clock.now());
      return this.error(artifactFailureCode(error), this.mustGetRun(run.run_id));
    }
    this.store.setAuthorizationStatus(authorization.approval_id, "consumed");
    this.store.setState(run.run_id, "disclosing", this.clock.now());
    let outcome: DeliveryOutcome;
    try {
      outcome = this.disclosureMailer.deliver(
        { ...heldEnvelope.envelope, bytes: new Uint8Array(bytes) },
        command.idempotency_key,
      );
    } catch {
      outcome = "ambiguous";
    }
    const deliveryStatus = outcome === "accepted" ? "accepted" : outcome === "ambiguous" ? "delivery_unknown" : "rejected";
    this.store.addDisclosureAttempt({
      attempt_id: attemptId,
      run_id: run.run_id,
      revision: run.revision,
      idempotency_key: command.idempotency_key,
      disclosure_fingerprint: fingerprint,
      status: deliveryStatus,
    }, this.clock.now());
    this.store.setState(run.run_id, deliveryStatus === "accepted" ? "disclosed" : deliveryStatus === "delivery_unknown" ? "delivery_unknown" : "failed", this.clock.now(), undefined, undefined, {
      attempt_id: attemptId,
      idempotency_key: command.idempotency_key,
      status: deliveryStatus,
      disclosure_fingerprint: fingerprint,
    });
    if (outcome === "accepted") return success(this.mustGetRun(run.run_id));
    return this.error(outcome === "ambiguous" ? "delivery_unknown" : "disclosure_rejected", this.mustGetRun(run.run_id));
  }

  private authorizedRun(runId: string, revision: number, artifactSha256: string, expectedState: RunState): StoredRun {
    const run = this.store.getRun(runId);
    if (!run) throw new CommandFailure("run_not_found");
    if (run.revision !== revision || run.artifact.sha256 !== artifactSha256) throw new CommandFailure("stale_identity");
    if (run.state !== expectedState) throw new CommandFailure("stale_state");
    return run;
  }

  private mustGetRun(runId: string): StoredRun {
    const run = this.store.getRun(runId);
    if (!run) throw new Error("run disappeared");
    return run;
  }

  private discardCandidate(run: StoredRun, verification?: EngineVerifyResult): void {
    this.discardArtifact(run.artifact, run.original_artifact);
    this.store.restoreOriginalAndRefuse(run.run_id, verification, this.clock.now());
  }

  private discardArtifact(candidate: ArtifactReference | undefined, original: ArtifactReference): void {
    if (!candidate || candidate.reference === original.reference) return;
    this.artifactStore.discard?.(candidate);
  }

  private error(code: string, run?: StoredRun): ErrorResponse {
    const response: ErrorResponse = {
      version: API_VERSION,
      ok: false,
      error: { code, message: publicErrorMessage(code) },
    };
    if (run) response.run = publicRun(run, this.revealReferencesForRun(run));
    return response;
  }

  private refreshCachedResponse(response: ApiResponse): ApiResponse {
    const runId = response.ok ? response.run.run_id : response.run?.run_id;
    if (!runId) return response;
    const run = this.store.getRun(runId);
    if (!run) return response;
    const refreshedRun = publicRun(run, this.revealReferencesForRun(run));
    return { ...response, run: refreshedRun };
  }

  readReveal(runId: string, reference: string): RevealSample | undefined {
    const stored = this.reveals.get(reference);
    if (!stored) return undefined;
    const run = this.store.getRun(runId);
    if (
      !run ||
      run.run_id !== stored.reference.run_id ||
      run.revision !== stored.reference.revision ||
      run.artifact.sha256 !== stored.artifact_sha256
    ) {
      this.deleteReveal(reference);
      return undefined;
    }
    try {
      this.artifactStore.read(run.artifact);
    } catch {
      this.deleteReveal(reference);
      return undefined;
    }
    const expiresAt = Date.parse(stored.reference.expires_at);
    if (!Number.isFinite(expiresAt) || this.clock.now() >= expiresAt) {
      this.deleteReveal(reference);
      return undefined;
    }
    return {
      run_id: stored.reference.run_id,
      revision: stored.reference.revision,
      finding_index: stored.reference.finding_index,
      expires_at: stored.reference.expires_at,
      rows: stored.rows.map((row) => ({ ...row, values: [...row.values] })),
    };
  }

  private prepareReveals(run: StoredRun, findings: readonly Finding[]): void {
    this.clearReveals(run.run_id);
    const reveal = this.engine.reveal;
    if (!this.revealEnabled || !reveal) return;
    findings.forEach((finding, findingIndex) => {
      let rows: RevealRow[];
      try {
        rows = reveal.call(this.engine, run.artifact, finding);
      } catch {
        return;
      }
      if (!Array.isArray(rows)) return;
      const safeRows = rows.slice(0, 5)
        .filter((row): row is RevealRow => (
          row !== null &&
          typeof row === "object" &&
          typeof row.worksheet === "string" &&
          row.worksheet.length > 0 &&
          Number.isSafeInteger(row.row) &&
          row.row >= 1 &&
          Array.isArray(row.values) &&
          row.values.every((value) => typeof value === "string")
        ))
        .map((row) => ({
          worksheet: row.worksheet,
          row: row.row,
          values: [...row.values],
        }));
      if (safeRows.length === 0) return;
      const reference = `peel-reveal-${newId()}`;
      const expiresAt = this.clock.now() + REVEAL_TTL_MS;
      this.reveals.set(reference, {
        reference: {
          reference,
          run_id: run.run_id,
          revision: run.revision,
          finding_index: findingIndex,
          row_count: safeRows.length,
          expires_at: isoTime(expiresAt),
        },
        artifact_sha256: run.artifact.sha256,
        rows: safeRows,
      });
      const timer = setTimeout(() => {
        const current = this.reveals.get(reference);
        if (current?.reference.expires_at === isoTime(expiresAt)) this.reveals.delete(reference);
        this.revealTimers.delete(reference);
      }, REVEAL_TTL_MS);
      timer.unref?.();
      this.revealTimers.set(reference, timer);
    });
  }

  private revealReferencesForRun(run: StoredRun): RevealReference[] {
    const active: RevealReference[] = [];
    for (const [key, reveal] of this.reveals) {
      if (reveal.reference.run_id !== run.run_id) continue;
      if (this.clock.now() >= Date.parse(reveal.reference.expires_at)) {
        this.deleteReveal(key);
        continue;
      }
      if (reveal.reference.revision === run.revision && reveal.artifact_sha256 === run.artifact.sha256) {
        active.push(reveal.reference);
      } else {
        this.deleteReveal(key);
      }
    }
    return active.sort((left, right) => left.finding_index - right.finding_index);
  }

  private clearReveals(runId: string): void {
    for (const [key, reveal] of this.reveals) {
      if (reveal.reference.run_id === runId) this.deleteReveal(key);
    }
  }

  private deleteReveal(reference: string): void {
    this.reveals.delete(reference);
    const timer = this.revealTimers.get(reference);
    if (timer) clearTimeout(timer);
    this.revealTimers.delete(reference);
  }
}

function publicErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    invalid_schema: "The command does not match the versioned Peel contract.",
    insufficient_context: "The draft envelope does not contain exactly one non-empty Claimed Scope.",
    recipient_not_allowed: "The recipient is outside the configured allowlist.",
    artifact_too_large: "The artifact exceeds the supported size limit.",
    artifact_expired: "The Artifact Reference has expired.",
    artifact_undeclared: "The Artifact Reference is not registered.",
    artifact_integrity_failure: "The Artifact Reference failed its boundary integrity check.",
    command_replay_conflict: "The command identity was already consumed for different content.",
    run_already_disclosed: "A disclosed Run cannot be revised.",
    run_not_found: "The Run does not exist.",
    stale_identity: "The command is bound to a stale or different Run identity.",
    stale_state: "The Run is not in the expected state for this command.",
    authorization_not_found: "The Disclosure Approval does not exist.",
    authorization_binding_mismatch: "The Disclosure Approval is not bound to this exact envelope and artifact.",
    authorization_not_pending: "The Disclosure Approval is no longer pending.",
    authorization_expired: "The Disclosure Approval expired before the decision.",
    duplicate_disclosure: "This Disclosure Fingerprint was already accepted.",
    disclosure_rejected: "The Disclosure was rejected before acceptance.",
    delivery_unknown: "SMTP acceptance is ambiguous; no automatic retry was performed.",
    envelope_unavailable: "The exact draft envelope is not available for this Run.",
    invalid_engine_result: "The workbook engine returned an invalid versioned result.",
    engine_failed: "The workbook engine could not produce a result.",
    artifact_identity_mismatch: "The engine result does not match the bound artifact.",
    scope_mismatch: "The Claimed Scope does not match the bounded Finding evidence; the Run was refused.",
    scope_insufficient_context: "The Claimed Scope could not be assessed with sufficient context; the Run was refused.",
    scope_assessment_failed: "Scope Assessment could not be completed; the Run was refused.",
    repair_plan_unavailable: "The workbook did not produce a complete eligible Repair Plan.",
    repair_plan_identity_mismatch: "The Repair Plan is not bound to the staged artifact.",
    repair_refused: "A dependency or unsupported capability prevents a safe Repair.",
    repair_failed: "The Repair could not be completed atomically; the candidate was destroyed.",
    verification_failed: "The repaired artifact failed supported-profile Verification and was destroyed.",
    command_failed: "The command could not be completed safely.",
  };
  return messages[code] ?? "The command was refused safely.";
}

export {
  FakeClock,
  FakeDisclosureMailer,
  FakeScopeAssessor,
  InMemoryArtifactStore,
  UnavailableScopeAssessor,
} from "./adapters.js";
