export const API_VERSION = "1" as const;
export const ENGINE_VERSION = "1.0.0" as const;
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const REVEAL_TTL_MS = 60 * 1000;

export type RunState =
  | "staged"
  | "scanned"
  | "awaiting_repair_approval"
  | "repairing"
  | "verified"
  | "awaiting_disclosure_approval"
  | "disclosing"
  | "disclosed"
  | "refused"
  | "failed"
  | "delivery_unknown";

export type CommandName =
  | "stage"
  | "scan"
  | "apply_repair"
  | "verify"
  | "request_disclosure"
  | "respond_disclosure";

export interface ArtifactReference {
  reference: string;
  filename: string;
  media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  byte_size: number;
  sha256: string;
}

export interface TriggerIdentity {
  mailbox_account: string;
  folder_uidvalidity: string;
  message_uid: string;
  attachment_sha256: string;
}

export interface Envelope {
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  attachment: ArtifactReference;
}

export interface StageCommand {
  version: typeof API_VERSION;
  command: "stage";
  command_id: string;
  expected_state: "new";
  trigger: TriggerIdentity;
  envelope: Envelope;
}

export interface RunCommandBase {
  version: typeof API_VERSION;
  command_id: string;
  run_id: string;
  revision: number;
  artifact_sha256: string;
}

export interface ScanCommand extends RunCommandBase {
  command: "scan";
  expected_state: "staged";
}

export interface RepairApprovalBinding {
  run_id: string;
  revision: number;
  original_artifact_sha256: string;
  repair_plan_sha256: string;
  engine_version: string;
}

export interface RepairAction {
  kind: "delete_hidden_worksheet";
  worksheet: string;
  target_member: string;
  changed_members: string[];
  capability_losses: string[];
}

export interface DependencyAnalysis {
  visible_formulas: string[];
  defined_names: string[];
  data_validation: string[];
  tables: string[];
  charts: string[];
  pivots: string[];
  package_relationships: string[];
  macros: string[];
  external_connections: string[];
}

export interface RepairPlan {
  version: typeof API_VERSION;
  operation: "repair_plan";
  status: "eligible" | "refused";
  artifact_sha256: string;
  engine_version: string;
  dependency_analysis: DependencyAnalysis;
  actions: RepairAction[];
  changed_members: string[];
  capability_losses: string[];
  refusal_reasons?: string[];
}

export interface RepairApprovalView {
  approval_id: string;
  expires_at: string;
  idempotency_key: string;
  binding: RepairApprovalBinding;
}

export interface ApplyRepairCommand extends RunCommandBase {
  command: "apply_repair";
  expected_state: "awaiting_repair_approval";
  approval_id: string;
  idempotency_key: string;
  binding: RepairApprovalBinding;
}

export interface VerifyCommand extends RunCommandBase {
  command: "verify";
  expected_state: "scanned";
}

export interface RequestDisclosureCommand extends RunCommandBase {
  command: "request_disclosure";
  expected_state: "verified";
}

export interface DisclosureBinding {
  run_id: string;
  revision: number;
  envelope_revision_hash: string;
  artifact_sha256: string;
  sender: string;
  recipient: string;
  subject: string;
  attachment_filename: string;
  body_sha256: string;
}

export interface RespondDisclosureCommand extends RunCommandBase {
  command: "respond_disclosure";
  expected_state: "awaiting_disclosure_approval";
  approval_id: string;
  idempotency_key: string;
  decision: "approve" | "deny";
  binding: DisclosureBinding;
}

export type Command =
  | StageCommand
  | ScanCommand
  | ApplyRepairCommand
  | VerifyCommand
  | RequestDisclosureCommand
  | RespondDisclosureCommand;

export interface Finding {
  mechanism: "hidden_worksheet" | "hidden_row_or_column" | "pivot_cache";
  location: string;
  count: number;
}

export type ScopeAssessmentStatus = "mismatch" | "insufficient_context" | "no_mismatch_found";

export interface ScopeAssessmentInput {
  claimed_scope: string;
  findings: Finding[];
}

export interface ScopeAssessmentResult {
  version: typeof API_VERSION;
  operation: "scope_assessment";
  status: ScopeAssessmentStatus;
}

export interface ScopeAssessor {
  assess(input: ScopeAssessmentInput): ScopeAssessmentResult;
}

export interface ScopeAssessmentEvidence {
  status: ScopeAssessmentStatus;
}

export interface RevealRow {
  worksheet: string;
  row: number;
  values: string[];
}

export interface RevealReference {
  reference: string;
  run_id: string;
  revision: number;
  finding_index: number;
  row_count: number;
  expires_at: string;
}

export interface RevealSample {
  run_id: string;
  revision: number;
  finding_index: number;
  expires_at: string;
  rows: RevealRow[];
}

export interface EngineScanResult {
  version: typeof API_VERSION;
  operation: "scan";
  status: "clean" | "findings" | "refused";
  artifact_sha256: string;
  engine_version: string;
  supported_profile: "accepted" | "refused";
  findings: Finding[];
  repair_plan?: RepairPlan;
  refusal_code?: "unsupported_container" | "unsupported_content" | "integrity_failure";
}

export interface EngineRepairResult {
  version: typeof API_VERSION;
  operation: "repair";
  status: "repaired" | "refused";
  artifact_sha256: string;
  original_artifact_sha256: string;
  engine_version: string;
  repair_plan_sha256: string;
  changed_members: string[];
  candidate_artifact?: ArtifactReference;
  refusal_code?: "unsupported_container" | "unsupported_content" | "integrity_failure";
}

export interface EngineVerifyResult {
  version: typeof API_VERSION;
  operation: "verify";
  status: "verified" | "refused";
  artifact_sha256: string;
  original_artifact_sha256: string;
  engine_version: string;
  artifact_unchanged: boolean;
  baseline_sha256: string;
  remaining_findings: Finding[];
  relationships_valid?: boolean;
  content_types_valid?: boolean;
  reopened_with?: string[];
  changed_members?: string[];
  unexplained_changes?: string[];
  refusal_code?: "unsupported_container" | "unsupported_content" | "integrity_failure";
}

export interface ScanEvidence {
  status: "clean" | "findings" | "refused";
  artifact_sha256: string;
  engine_version: string;
  finding_count: number;
  findings: Finding[];
  supported_profile: "accepted" | "refused";
  refusal_code?: string;
}

export interface VerificationEvidence {
  status: "verified" | "refused";
  artifact_sha256: string;
  engine_version: string;
  artifact_unchanged: boolean;
  baseline_sha256: string;
  remaining_finding_count: number;
  refusal_code?: string;
}

export interface DeliveryEvidence {
  attempt_id: string;
  idempotency_key: string;
  status: "denied" | "accepted" | "rejected" | "delivery_unknown";
  disclosure_fingerprint: string;
}

export interface RunView {
  run_id: string;
  revision: number;
  state: RunState;
  envelope_revision_hash: string;
  artifact: ArtifactReference;
  original_artifact: ArtifactReference;
  scan?: ScanEvidence;
  scope_assessment?: ScopeAssessmentEvidence;
  repair_plan?: RepairPlan;
  repair?: RepairEvidence;
  repair_approval?: RepairApprovalView;
  reveals?: RevealReference[];
  verification?: VerificationEvidence;
  delivery?: DeliveryEvidence;
}

export interface RepairEvidence {
  original_artifact_sha256: string;
  artifact_sha256: string;
  repair_plan_sha256: string;
  engine_version: string;
  changed_members: string[];
}

export interface ApprovalView {
  approval_id: string;
  expires_at: string;
  idempotency_key: string;
  binding: DisclosureBinding;
}

export interface SuccessResponse {
  version: typeof API_VERSION;
  ok: true;
  run: RunView;
  approval?: ApprovalView;
  repair_approval?: RepairApprovalView;
  deduplicated?: boolean;
}

export interface ErrorResponse {
  version: typeof API_VERSION;
  ok: false;
  error: {
    code: string;
    message: string;
  };
  run?: RunView;
}

export type ApiResponse = SuccessResponse | ErrorResponse;

export interface Clock {
  now(): number;
}

export interface ArtifactStore {
  put(bytes: Uint8Array, filename: string, ttlMs?: number): ArtifactReference;
  read(reference: ArtifactReference): Uint8Array;
  discard?(reference: ArtifactReference): void;
}

export interface EngineAdapter {
  scan(reference: ArtifactReference): EngineScanResult;
  repair?(reference: ArtifactReference, plan: RepairPlan): EngineRepairResult;
  verify(
    reference: ArtifactReference,
    originalArtifactSha256: string,
    plan?: RepairPlan,
    originalReference?: ArtifactReference,
  ): EngineVerifyResult;
  reveal?(reference: ArtifactReference, finding: Finding): RevealRow[];
}

export interface DisclosureMessage {
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  attachment: ArtifactReference;
  bytes: Uint8Array;
}

export type DeliveryOutcome = "accepted" | "rejected" | "ambiguous";

export interface DisclosureMailer {
  deliver(message: DisclosureMessage, idempotencyKey: string): DeliveryOutcome;
}
