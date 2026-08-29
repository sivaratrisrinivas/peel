import {
  API_VERSION,
  MAX_ARTIFACT_BYTES,
  type ArtifactReference,
  type Command,
  type DisclosureBinding,
  type EngineScanResult,
  type EngineRepairResult,
  type EngineVerifyResult,
  type Envelope,
  type Finding,
  type DependencyAnalysis,
  type RepairAction,
  type RepairApprovalBinding,
  type RepairPlan,
  type ScopeAssessmentResult,
  type TriggerIdentity,
} from "./contracts.js";

export class SchemaError extends Error {
  readonly code = "invalid_schema";

  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SchemaError(`${path} must be an object`);
  }
  return value as RecordValue;
}

function exactKeys(value: RecordValue, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new SchemaError(`${path}.${key} is not permitted`);
  }
}

function stringValue(value: unknown, path: string, nonEmpty = true): string {
  if (typeof value !== "string" || (nonEmpty && value.trim() === "")) {
    throw new SchemaError(`${path} must be a non-empty string`);
  }
  return value;
}

function uuidValue(value: unknown, path: string): string {
  const uuid = stringValue(value, path);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new SchemaError(`${path} must be a UUID`);
  }
  return uuid;
}

function hashValue(value: unknown, path: string): string {
  const hash = stringValue(value, path);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new SchemaError(`${path} must be a SHA-256 hex digest`);
  return hash;
}

function integerValue(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new SchemaError(`${path} must be an integer >= ${minimum}`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new SchemaError(`${path} has an unsupported value`);
  }
  return value as T;
}

export function parseArtifactReference(value: unknown, path = "artifact"): ArtifactReference {
  const input = record(value, path);
  exactKeys(input, ["reference", "filename", "media_type", "byte_size", "sha256"], path);
  const reference = stringValue(input.reference, `${path}.reference`);
  if (!/^peel-artifact-[A-Za-z0-9_-]{22}$/.test(reference)) {
    throw new SchemaError(`${path}.reference is not an opaque Artifact Reference`);
  }
  const filename = stringValue(input.filename, `${path}.filename`);
  if (filename.includes("/") || filename.includes("\\") || !filename.toLowerCase().endsWith(".xlsx")) {
    throw new SchemaError(`${path}.filename must be one .xlsx filename`);
  }
  const mediaType = enumValue(
    input.media_type,
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] as const,
    `${path}.media_type`,
  );
  const byteSize = integerValue(input.byte_size, `${path}.byte_size`);
  if (byteSize > MAX_ARTIFACT_BYTES) throw new SchemaError(`${path}.byte_size exceeds the limit`);
  return {
    reference,
    filename,
    media_type: mediaType,
    byte_size: byteSize,
    sha256: hashValue(input.sha256, `${path}.sha256`),
  };
}

function parseTrigger(value: unknown): TriggerIdentity {
  const input = record(value, "trigger");
  exactKeys(input, ["mailbox_account", "folder_uidvalidity", "message_uid", "attachment_sha256", "envelope_revision_hash"], "trigger");
  const trigger: TriggerIdentity = {
    mailbox_account: stringValue(input.mailbox_account, "trigger.mailbox_account"),
    folder_uidvalidity: stringValue(input.folder_uidvalidity, "trigger.folder_uidvalidity"),
    message_uid: stringValue(input.message_uid, "trigger.message_uid"),
    attachment_sha256: hashValue(input.attachment_sha256, "trigger.attachment_sha256"),
  };
  if (input.envelope_revision_hash !== undefined) {
    trigger.envelope_revision_hash = hashValue(input.envelope_revision_hash, "trigger.envelope_revision_hash");
  }
  return trigger;
}

function parseEnvelope(value: unknown): Envelope {
  const input = record(value, "envelope");
  exactKeys(input, ["sender", "recipient", "subject", "body", "attachment"], "envelope");
  return {
    sender: stringValue(input.sender, "envelope.sender"),
    recipient: stringValue(input.recipient, "envelope.recipient"),
    subject: stringValue(input.subject, "envelope.subject"),
    body: stringValue(input.body, "envelope.body"),
    attachment: parseArtifactReference(input.attachment, "envelope.attachment"),
  };
}

function parseCommandBase(value: RecordValue, path: string): void {
  uuidValue(value.command_id, `${path}.command_id`);
}

function parseRunBase(value: RecordValue, path: string): { run_id: string; revision: number; artifact_sha256: string } {
  return {
    run_id: uuidValue(value.run_id, `${path}.run_id`),
    revision: integerValue(value.revision, `${path}.revision`, 1),
    artifact_sha256: hashValue(value.artifact_sha256, `${path}.artifact_sha256`),
  };
}

function parseBinding(value: unknown): DisclosureBinding {
  const input = record(value, "binding");
  exactKeys(
    input,
    [
      "run_id",
      "revision",
      "envelope_revision_hash",
      "artifact_sha256",
      "sender",
      "recipient",
      "subject",
      "attachment_filename",
      "body_sha256",
    ],
    "binding",
  );
  return {
    run_id: uuidValue(input.run_id, "binding.run_id"),
    revision: integerValue(input.revision, "binding.revision", 1),
    envelope_revision_hash: hashValue(input.envelope_revision_hash, "binding.envelope_revision_hash"),
    artifact_sha256: hashValue(input.artifact_sha256, "binding.artifact_sha256"),
    sender: stringValue(input.sender, "binding.sender"),
    recipient: stringValue(input.recipient, "binding.recipient"),
    subject: stringValue(input.subject, "binding.subject"),
    attachment_filename: stringValue(input.attachment_filename, "binding.attachment_filename"),
    body_sha256: hashValue(input.body_sha256, "binding.body_sha256"),
  };
}

function parseRepairBinding(value: unknown): RepairApprovalBinding {
  const input = record(value, "binding");
  exactKeys(input, ["run_id", "revision", "original_artifact_sha256", "repair_plan_sha256", "engine_version"], "binding");
  return {
    run_id: uuidValue(input.run_id, "binding.run_id"),
    revision: integerValue(input.revision, "binding.revision", 1),
    original_artifact_sha256: hashValue(input.original_artifact_sha256, "binding.original_artifact_sha256"),
    repair_plan_sha256: hashValue(input.repair_plan_sha256, "binding.repair_plan_sha256"),
    engine_version: stringValue(input.engine_version, "binding.engine_version"),
  };
}

function parseStringArray(value: unknown, path: string, minimum = 0): string[] {
  if (!Array.isArray(value)) throw new SchemaError(`${path} must be an array`);
  if (value.length < minimum) throw new SchemaError(`${path} must contain at least ${minimum} item(s)`);
  return value.map((item, index) => stringValue(item, `${path}[${index}]`));
}

function parseDependencyAnalysis(value: unknown): DependencyAnalysis {
  const input = record(value, "repair_plan.dependency_analysis");
  const keys = [
    "visible_formulas",
    "defined_names",
    "data_validation",
    "tables",
    "charts",
    "pivots",
    "package_relationships",
    "macros",
    "external_connections",
  ] as const;
  exactKeys(input, keys, "repair_plan.dependency_analysis");
  return Object.fromEntries(keys.map((key) => [key, parseStringArray(input[key], `repair_plan.dependency_analysis.${key}`)])) as unknown as DependencyAnalysis;
}

function parseRepairAction(value: unknown, index: number): RepairAction {
  const input = record(value, `repair_plan.actions[${index}]`);
  const kind = enumValue(input.kind, ["delete_hidden_worksheet", "clear_hidden_cell_values"] as const, `repair_plan.actions[${index}].kind`);
  const path = `repair_plan.actions[${index}]`;
  const commonKeys = ["kind", "worksheet", "target_member", "changed_members", "capability_losses"];
  exactKeys(input, kind === "clear_hidden_cell_values" ? [...commonKeys, "cell_references"] : commonKeys, path);
  const common = {
    worksheet: stringValue(input.worksheet, `${path}.worksheet`),
    target_member: stringValue(input.target_member, `${path}.target_member`),
    changed_members: parseStringArray(input.changed_members, `${path}.changed_members`, 1),
    capability_losses: parseStringArray(input.capability_losses, `${path}.capability_losses`, 1),
  };
  if (kind === "delete_hidden_worksheet") return { kind, ...common };
  return {
    kind,
    ...common,
    cell_references: parseStringArray(input.cell_references, `${path}.cell_references`, 1),
  };
}

function parseRepairPlan(value: unknown): RepairPlan {
  const input = record(value, "repair_plan");
  exactKeys(input, ["version", "operation", "status", "artifact_sha256", "engine_version", "dependency_analysis", "actions", "changed_members", "capability_losses", "refusal_reasons"], "repair_plan");
  if (input.version !== API_VERSION || input.operation !== "repair_plan") throw new SchemaError("repair plan identity is invalid");
  const actionsValue = input.actions;
  if (!Array.isArray(actionsValue)) throw new SchemaError("repair_plan.actions must be an array");
  const output: RepairPlan = {
    version: API_VERSION,
    operation: "repair_plan",
    status: enumValue(input.status, ["eligible", "refused"] as const, "repair_plan.status"),
    artifact_sha256: hashValue(input.artifact_sha256, "repair_plan.artifact_sha256"),
    engine_version: stringValue(input.engine_version, "repair_plan.engine_version"),
    dependency_analysis: parseDependencyAnalysis(input.dependency_analysis),
    actions: actionsValue.map(parseRepairAction),
    changed_members: parseStringArray(input.changed_members, "repair_plan.changed_members", 0),
    capability_losses: parseStringArray(input.capability_losses, "repair_plan.capability_losses", 1),
  };
  if (input.refusal_reasons !== undefined) output.refusal_reasons = parseStringArray(input.refusal_reasons, "repair_plan.refusal_reasons", 1);
  if (output.status === "eligible" && (output.actions.length === 0 || output.changed_members.length === 0)) {
    throw new SchemaError("eligible repair plan must contain actions and changed members");
  }
  if (output.status === "refused" && (output.actions.length !== 0 || !output.refusal_reasons)) {
    throw new SchemaError("refused repair plan must contain refusal reasons and no actions");
  }
  return output;
}

export function parseCommand(value: unknown): Command {
  const input = record(value, "command");
  if (input.version !== API_VERSION) throw new SchemaError("command.version is unsupported");
  const command = enumValue(
    input.command,
    ["stage", "scan", "apply_repair", "verify", "request_disclosure", "respond_disclosure"] as const,
    "command.command",
  );
  parseCommandBase(input, "command");

  if (command === "stage") {
    exactKeys(input, ["version", "command", "command_id", "expected_state", "trigger", "envelope"], "command");
    if (input.expected_state !== "new") throw new SchemaError("stage.expected_state must be new");
    const trigger = parseTrigger(input.trigger);
    const envelope = parseEnvelope(input.envelope);
    if (trigger.attachment_sha256 !== envelope.attachment.sha256) {
      throw new SchemaError("trigger and envelope attachment hashes differ");
    }
    return { version: API_VERSION, command, command_id: String(input.command_id), expected_state: "new", trigger, envelope };
  }

  exactKeys(
    input,
    command === "respond_disclosure"
      ? ["version", "command", "command_id", "expected_state", "run_id", "revision", "artifact_sha256", "approval_id", "idempotency_key", "decision", "binding"]
      : command === "apply_repair"
        ? ["version", "command", "command_id", "expected_state", "run_id", "revision", "artifact_sha256", "approval_id", "idempotency_key", "binding"]
      : ["version", "command", "command_id", "expected_state", "run_id", "revision", "artifact_sha256"],
    "command",
  );
  const base = parseRunBase(input, "command");
  const expectedStates = {
    scan: "staged",
    apply_repair: "awaiting_repair_approval",
    verify: "scanned",
    request_disclosure: "verified",
    respond_disclosure: "awaiting_disclosure_approval",
  } as const;
  if (input.expected_state !== expectedStates[command]) {
    throw new SchemaError(`${command}.expected_state is invalid`);
  }
  if (command === "scan") return { version: API_VERSION, command, command_id: String(input.command_id), expected_state: "staged", ...base };
  if (command === "apply_repair") return {
    version: API_VERSION,
    command,
    command_id: String(input.command_id),
    expected_state: "awaiting_repair_approval",
    ...base,
    approval_id: uuidValue(input.approval_id, "command.approval_id"),
    idempotency_key: uuidValue(input.idempotency_key, "command.idempotency_key"),
    binding: parseRepairBinding(input.binding),
  };
  if (command === "verify") return { version: API_VERSION, command, command_id: String(input.command_id), expected_state: "scanned", ...base };
  if (command === "request_disclosure") return { version: API_VERSION, command, command_id: String(input.command_id), expected_state: "verified", ...base };
  return {
    version: API_VERSION,
    command,
    command_id: String(input.command_id),
    expected_state: "awaiting_disclosure_approval",
    ...base,
    approval_id: uuidValue(input.approval_id, "command.approval_id"),
    idempotency_key: uuidValue(input.idempotency_key, "command.idempotency_key"),
    decision: enumValue(input.decision, ["approve", "deny"] as const, "command.decision"),
    binding: parseBinding(input.binding),
  };
}

function parseFinding(value: unknown, index: number): Finding {
  const input = record(value, `findings[${index}]`);
  exactKeys(input, ["mechanism", "location", "count"], `findings[${index}]`);
  return {
    mechanism: enumValue(input.mechanism, ["hidden_worksheet", "hidden_row_or_column", "pivot_cache"] as const, `findings[${index}].mechanism`),
    location: stringValue(input.location, `findings[${index}].location`),
    count: integerValue(input.count, `findings[${index}].count`, 1),
  };
}

function parseFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) throw new SchemaError("findings must be an array");
  return value.map(parseFinding);
}

export function parseEngineScanResult(value: unknown): EngineScanResult {
  const input = record(value, "engine result");
  exactKeys(input, ["version", "operation", "status", "artifact_sha256", "engine_version", "supported_profile", "findings", "repair_plan", "refusal_code"], "engine result");
  if (input.version !== API_VERSION || input.operation !== "scan") throw new SchemaError("engine scan identity is invalid");
  const status = enumValue(input.status, ["clean", "findings", "refused"] as const, "engine.status");
  const supportedProfile = enumValue(input.supported_profile, ["accepted", "refused"] as const, "engine.supported_profile");
  const findings = parseFindings(input.findings);
  if (status === "clean" && supportedProfile !== "accepted") throw new SchemaError("clean engine result must accept the supported profile");
  if (status === "refused" && supportedProfile !== "refused") throw new SchemaError("refused engine result must refuse the supported profile");
  if (status === "findings" && supportedProfile !== "accepted") throw new SchemaError("findings engine result must accept the supported profile");
  if (status === "clean" && findings.length !== 0) throw new SchemaError("clean engine result cannot contain findings");
  if (status === "findings" && findings.length === 0) throw new SchemaError("findings result must contain findings");
  const output: EngineScanResult = {
    version: API_VERSION,
    operation: "scan",
    status,
    artifact_sha256: hashValue(input.artifact_sha256, "engine.artifact_sha256"),
    engine_version: stringValue(input.engine_version, "engine.engine_version"),
    supported_profile: supportedProfile,
    findings,
  };
  if (input.repair_plan !== undefined) output.repair_plan = parseRepairPlan(input.repair_plan);
  if (input.refusal_code !== undefined) {
    output.refusal_code = enumValue(input.refusal_code, ["unsupported_container", "unsupported_content", "integrity_failure"] as const, "engine.refusal_code");
  }
  return output;
}

export function parseEngineRepairResult(value: unknown): EngineRepairResult {
  const input = record(value, "engine result");
  exactKeys(input, ["version", "operation", "status", "artifact_sha256", "original_artifact_sha256", "engine_version", "repair_plan_sha256", "changed_members", "candidate_artifact", "refusal_code"], "engine result");
  if (input.version !== API_VERSION || input.operation !== "repair") throw new SchemaError("engine repair identity is invalid");
  const status = enumValue(input.status, ["repaired", "refused"] as const, "engine.status");
  const output: EngineRepairResult = {
    version: API_VERSION,
    operation: "repair",
    status,
    artifact_sha256: hashValue(input.artifact_sha256, "engine.artifact_sha256"),
    original_artifact_sha256: hashValue(input.original_artifact_sha256, "engine.original_artifact_sha256"),
    engine_version: stringValue(input.engine_version, "engine.engine_version"),
    repair_plan_sha256: hashValue(input.repair_plan_sha256, "engine.repair_plan_sha256"),
    changed_members: parseStringArray(input.changed_members, "engine.changed_members"),
  };
  if (input.candidate_artifact !== undefined) output.candidate_artifact = parseArtifactReference(input.candidate_artifact, "engine.candidate_artifact");
  if (status === "repaired" && output.candidate_artifact === undefined) throw new SchemaError("repaired result must contain a candidate artifact");
  if (input.refusal_code !== undefined) output.refusal_code = enumValue(input.refusal_code, ["unsupported_container", "unsupported_content", "integrity_failure"] as const, "engine.refusal_code");
  return output;
}

export function parseEngineVerifyResult(value: unknown): EngineVerifyResult {
  const input = record(value, "engine result");
  exactKeys(input, ["version", "operation", "status", "artifact_sha256", "original_artifact_sha256", "engine_version", "artifact_unchanged", "baseline_sha256", "remaining_findings", "relationships_valid", "content_types_valid", "reopened_with", "changed_members", "unexplained_changes", "refusal_code"], "engine result");
  if (input.version !== API_VERSION || input.operation !== "verify") throw new SchemaError("engine verify identity is invalid");
  const status = enumValue(input.status, ["verified", "refused"] as const, "engine.status");
  if (typeof input.artifact_unchanged !== "boolean") throw new SchemaError("engine.artifact_unchanged must be boolean");
  const remainingFindings = parseFindings(input.remaining_findings);
  if (status === "verified" && (!input.artifact_unchanged || remainingFindings.length !== 0)) {
    throw new SchemaError("verified engine result must prove unchanged artifact and no findings");
  }
  const output: EngineVerifyResult = {
    version: API_VERSION,
    operation: "verify",
    status,
    artifact_sha256: hashValue(input.artifact_sha256, "engine.artifact_sha256"),
    original_artifact_sha256: hashValue(input.original_artifact_sha256, "engine.original_artifact_sha256"),
    engine_version: stringValue(input.engine_version, "engine.engine_version"),
    artifact_unchanged: input.artifact_unchanged,
    baseline_sha256: hashValue(input.baseline_sha256, "engine.baseline_sha256"),
    remaining_findings: remainingFindings,
  };
  if (input.relationships_valid !== undefined) {
    if (typeof input.relationships_valid !== "boolean") throw new SchemaError("engine.relationships_valid must be boolean");
    output.relationships_valid = input.relationships_valid;
  }
  if (input.content_types_valid !== undefined) {
    if (typeof input.content_types_valid !== "boolean") throw new SchemaError("engine.content_types_valid must be boolean");
    output.content_types_valid = input.content_types_valid;
  }
  if (input.reopened_with !== undefined) output.reopened_with = parseStringArray(input.reopened_with, "engine.reopened_with");
  if (input.changed_members !== undefined) output.changed_members = parseStringArray(input.changed_members, "engine.changed_members");
  if (input.unexplained_changes !== undefined) output.unexplained_changes = parseStringArray(input.unexplained_changes, "engine.unexplained_changes");
  if (input.refusal_code !== undefined) {
    output.refusal_code = enumValue(input.refusal_code, ["unsupported_container", "unsupported_content", "integrity_failure"] as const, "engine.refusal_code");
  }
  return output;
}

export function parseScopeAssessmentResult(value: unknown): ScopeAssessmentResult {
  const input = record(value, "scope assessment");
  exactKeys(input, ["version", "operation", "status"], "scope assessment");
  if (input.version !== API_VERSION || input.operation !== "scope_assessment") {
    throw new SchemaError("scope assessment identity is invalid");
  }
  return {
    version: API_VERSION,
    operation: "scope_assessment",
    status: enumValue(
      input.status,
      ["mismatch", "insufficient_context", "no_mismatch_found"] as const,
      "scope assessment.status",
    ),
  };
}
