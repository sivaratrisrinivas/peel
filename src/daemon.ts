import {
  API_VERSION,
  ENGINE_VERSION,
  type ApiResponse,
  type ArtifactReference,
  type Clock,
  type Command,
  type DisclosureBinding,
  type Envelope,
  type ErrorResponse,
  type EngineScanResult,
  type EngineVerifyResult,
  type RunView,
  type SuccessResponse,
} from "./contracts.js";
import {
  ArtifactError,
  FakeDisclosureMailer,
  FakeWorkbookEngine,
  InMemoryArtifactStore,
  SystemClock,
} from "./adapters.js";
import { disclosureBinding, disclosureFingerprint, envelopeRevisionHash, newId, runKey, sha256, canonicalJson } from "./identity.js";
import { RunStore, toScanEvidence, toVerificationEvidence, type StoredRun } from "./store.js";
import {
  parseCommand,
  parseEngineScanResult,
  parseEngineVerifyResult,
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

export interface PeelDaemonOptions {
  allowedRecipients: readonly string[];
  artifactStore?: ArtifactStore;
  clock?: Clock;
  disclosureMailer?: DisclosureMailer;
  engine?: EngineAdapter;
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

function publicRun(run: StoredRun): RunView {
  const view: RunView = {
    run_id: run.run_id,
    revision: run.revision,
    state: run.state,
    envelope_revision_hash: run.envelope_revision_hash,
    artifact: run.artifact,
  };
  if (run.scan) view.scan = toScanEvidence(run.scan);
  if (run.verification) view.verification = toVerificationEvidence(run.verification);
  if (run.delivery) view.delivery = run.delivery;
  return view;
}

function success(run: StoredRun, extra: Pick<SuccessResponse, "approval" | "deduplicated"> = {}): SuccessResponse {
  const response: SuccessResponse = { version: API_VERSION, ok: true, run: publicRun(run) };
  if (extra.approval) response.approval = extra.approval;
  if (extra.deduplicated !== undefined) response.deduplicated = extra.deduplicated;
  return response;
}

export class PeelDaemon {
  readonly artifactStore: ArtifactStore;
  readonly disclosureMailer: DisclosureMailer;

  private readonly clock: Clock;
  private readonly engine: EngineAdapter;
  private readonly store: RunStore;
  private readonly allowedRecipients: ReadonlySet<string>;
  private readonly envelopes = new Map<string, InMemoryEnvelope>();

  constructor(options: PeelDaemonOptions) {
    if (options.allowedRecipients.length === 0) throw new Error("at least one allowed recipient is required");
    this.clock = options.clock ?? new SystemClock();
    this.artifactStore = options.artifactStore ?? new InMemoryArtifactStore(this.clock);
    this.disclosureMailer = options.disclosureMailer ?? new FakeDisclosureMailer();
    this.engine = options.engine ?? new FakeWorkbookEngine(this.artifactStore);
    this.store = new RunStore(options.databasePath ?? ":memory:");
    this.store.recoverAfterRestart(this.clock.now());
    this.allowedRecipients = new Set(options.allowedRecipients.map((recipient) => recipient.toLowerCase()));
  }

  close(): void {
    this.store.close();
  }

  getRun(runId: string): RunView | undefined {
    const run = this.store.getRun(runId);
    return run ? publicRun(run) : undefined;
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
      return JSON.parse(previous.response_json) as ApiResponse;
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
      };
      this.store.reviseRun(current.run_id, revised, this.clock.now());
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
      this.store.setState(run.run_id, "refused", this.clock.now());
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
    const nextState: RunState = result.status === "clean" ? "scanned" : "refused";
    this.store.setState(run.run_id, nextState, this.clock.now(), result);
    return success(this.mustGetRun(run.run_id));
  }

  private verify(command: Extract<Command, { command: "verify" }>): ApiResponse {
    const run = this.authorizedRun(command.run_id, command.revision, command.artifact_sha256, "scanned");
    try {
      this.artifactStore.read(run.artifact);
    } catch (error) {
      this.store.setState(run.run_id, "refused", this.clock.now());
      return this.error(artifactFailureCode(error), this.mustGetRun(run.run_id));
    }
    let result: EngineVerifyResult;
    try {
      result = parseEngineVerifyResult(this.engine.verify(run.artifact, run.artifact.sha256));
    } catch (error) {
      this.store.setState(run.run_id, "refused", this.clock.now());
      return this.error(error instanceof SchemaError ? "invalid_engine_result" : "engine_failed", this.mustGetRun(run.run_id));
    }
    if (result.artifact_sha256 !== run.artifact.sha256 || result.original_artifact_sha256 !== run.artifact.sha256) {
      this.store.setState(run.run_id, "refused", this.clock.now(), run.scan, result);
      return this.error("artifact_identity_mismatch", this.mustGetRun(run.run_id));
    }
    const nextState: RunState = result.status === "verified" ? "verified" : "refused";
    this.store.setState(run.run_id, nextState, this.clock.now(), run.scan, result);
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

  private error(code: string, run?: StoredRun): ErrorResponse {
    const response: ErrorResponse = {
      version: API_VERSION,
      ok: false,
      error: { code, message: publicErrorMessage(code) },
    };
    if (run) response.run = publicRun(run);
    return response;
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
    command_failed: "The command could not be completed safely.",
  };
  return messages[code] ?? "The command was refused safely.";
}

export { FakeClock, FakeDisclosureMailer, InMemoryArtifactStore } from "./adapters.js";
