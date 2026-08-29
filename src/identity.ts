import { createHash, randomUUID } from "node:crypto";

import type {
  DisclosureBinding,
  Envelope,
  RepairApprovalBinding,
  RepairPlan,
  TriggerIdentity,
} from "./contracts.js";

export function newId(): string {
  return randomUUID();
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(sortObject(value));
  if (encoded === undefined) throw new TypeError("value cannot be represented as canonical JSON");
  return encoded;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortObject(record[key])]),
    );
  }
  return value;
}

export function envelopeRevisionHash(envelope: Envelope): string {
  return sha256(
    canonicalJson({
      sender: envelope.sender,
      recipient: envelope.recipient,
      subject: envelope.subject,
      body: envelope.body,
      attachment: {
        filename: envelope.attachment.filename,
        media_type: envelope.attachment.media_type,
        sha256: envelope.attachment.sha256,
        byte_size: envelope.attachment.byte_size,
      },
    }),
  );
}

export function bodyHash(envelope: Envelope): string {
  return sha256(envelope.body);
}

export function repairPlanHash(plan: RepairPlan): string {
  return sha256(canonicalJson(plan));
}

export function repairApprovalBinding(
  runId: string,
  revision: number,
  originalArtifactSha256: string,
  plan: RepairPlan,
): RepairApprovalBinding {
  return {
    run_id: runId,
    revision,
    original_artifact_sha256: originalArtifactSha256,
    repair_plan_sha256: repairPlanHash(plan),
    engine_version: plan.engine_version,
  };
}

export function runKey(trigger: TriggerIdentity): string {
  // Envelope revisions belong to one mailbox message/artifact identity. The
  // stable key intentionally excludes the revision so an autosave edit
  // increments the existing Run revision instead of creating a second Run.
  return sha256(canonicalJson({
    mailbox_account: trigger.mailbox_account,
    folder_uidvalidity: trigger.folder_uidvalidity,
    message_uid: trigger.message_uid,
    attachment_sha256: trigger.attachment_sha256,
  }));
}

export function disclosureFingerprint(
  artifactSha256: string,
  envelope: Envelope,
): string {
  return sha256(
    canonicalJson({
      artifact_sha256: artifactSha256,
      recipient: envelope.recipient,
      subject: envelope.subject,
      body: envelope.body,
    }),
  );
}

export function disclosureBinding(
  runId: string,
  revision: number,
  envelopeRevision: string,
  artifactSha256: string,
  envelope: Envelope,
): DisclosureBinding {
  return {
    run_id: runId,
    revision,
    envelope_revision_hash: envelopeRevision,
    artifact_sha256: artifactSha256,
    sender: envelope.sender,
    recipient: envelope.recipient,
    subject: envelope.subject,
    attachment_filename: envelope.attachment.filename,
    body_sha256: bodyHash(envelope),
  };
}
