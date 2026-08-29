import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  API_VERSION,
  MAX_ARTIFACT_BYTES,
  type ArtifactReference,
  type RunView,
} from "./contracts.js";
import { envelopeRevisionHash, newId, sha256 } from "./identity.js";
import type { PeelDaemon } from "./daemon.js";

const execFileAsync = promisify(execFile);
const MAX_MAILBOX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
const DEFAULT_IMAP_SCRIPT = "scripts/mailbox_fetch.py";
const CLAIMED_SCOPE_PATTERN = /^\s*Intended disclosure\s*:\s*(.*?)\s*$/i;

export interface MailboxAttachment {
  filename: string;
  bytes: Uint8Array;
}

/** A normalized draft returned by a provider adapter, never by TrueForge. */
export interface MailboxDraft {
  mailbox_account: string;
  folder_uidvalidity: string;
  message_uid: string;
  sender: string;
  recipients: readonly string[];
  subject: string;
  body: string;
  attachments: readonly MailboxAttachment[];
}

export interface MailboxSource {
  listDrafts(): Promise<readonly MailboxDraft[]>;
}

export type MailboxErrorCode = "mailbox_unavailable" | "mailbox_invalid_response" | "mailbox_timeout";

export class MailboxError extends Error {
  readonly code: MailboxErrorCode;

  constructor(code: MailboxErrorCode) {
    super(code);
    this.name = "MailboxError";
    this.code = code;
  }
}

export interface MailboxTriggerIdentity {
  mailbox_account: string;
  folder_uidvalidity: string;
  message_uid: string;
  attachment_sha256: string;
  envelope_revision_hash: string;
}

export type MailboxPollStatus = "idle" | "ignored" | "triggered" | "deduplicated" | "blocked" | "error";

/**
 * The watcher result is intentionally bounded. It contains identity and Run
 * metadata only; draft bodies and attachment bytes never cross this boundary.
 */
export interface MailboxPollResult {
  status: MailboxPollStatus;
  identity?: MailboxTriggerIdentity;
  run?: RunView;
  error_code?: string;
}

export interface MailboxWatcherOptions {
  daemon: PeelDaemon;
  mailbox: MailboxSource;
  allowedRecipients: readonly string[];
  pollIntervalMs?: number;
  onResult?: (result: MailboxPollResult) => void;
}

export interface GmailImapMailboxOptions {
  pythonBin?: string;
  scriptPath?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  bridgeTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneDraft(draft: MailboxDraft): MailboxDraft {
  return {
    ...draft,
    recipients: [...draft.recipients],
    attachments: draft.attachments.map((attachment) => ({
      filename: attachment.filename,
      bytes: new Uint8Array(attachment.bytes),
    })),
  };
}

function claimedScopeIsUnambiguous(body: string): boolean {
  const fields = body
    .split(/\r?\n/)
    .filter((line) => CLAIMED_SCOPE_PATTERN.test(line))
    .map((line) => line.replace(/^\s*Intended disclosure\s*:\s*/i, "").trim());
  return fields.length === 1 && fields[0]!.length > 0;
}

function validAttachment(attachment: MailboxAttachment): boolean {
  return (
    nonEmptyString(attachment.filename) &&
    !attachment.filename.includes("/") &&
    !attachment.filename.includes("\\") &&
    attachment.filename.toLowerCase().endsWith(".xlsx") &&
    attachment.bytes.byteLength > 0 &&
    attachment.bytes.byteLength <= MAX_ARTIFACT_BYTES
  );
}

function normalizedRecipient(draft: MailboxDraft, allowed: ReadonlySet<string>): string | undefined {
  if (draft.recipients.length !== 1) return undefined;
  const recipient = draft.recipients[0];
  if (!nonEmptyString(recipient) || !allowed.has(recipient.trim().toLowerCase())) return undefined;
  return recipient.trim();
}

function makeRevisionArtifact(attachment: MailboxAttachment, digest: string): ArtifactReference {
  return {
    reference: `peel-artifact-${"0".repeat(22)}`,
    filename: attachment.filename,
    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    byte_size: attachment.bytes.byteLength,
    sha256: digest,
  };
}

function candidateIdentity(
  draft: MailboxDraft,
  recipient: string,
  attachment: MailboxAttachment,
): MailboxTriggerIdentity {
  const digest = sha256(attachment.bytes);
  const revision = envelopeRevisionHash({
    sender: draft.sender.trim(),
    recipient,
    subject: draft.subject.trim(),
    body: draft.body,
    attachment: makeRevisionArtifact(attachment, digest),
  });
  return {
    mailbox_account: draft.mailbox_account.trim(),
    folder_uidvalidity: draft.folder_uidvalidity.trim(),
    message_uid: draft.message_uid.trim(),
    attachment_sha256: digest,
    envelope_revision_hash: revision,
  };
}

interface EligibleDraft {
  draft: MailboxDraft;
  recipient: string;
  attachment: MailboxAttachment;
  identity: MailboxTriggerIdentity;
}

function eligibleDraft(draft: MailboxDraft, allowed: ReadonlySet<string>): EligibleDraft | undefined {
  if (
    !nonEmptyString(draft.mailbox_account) ||
    !nonEmptyString(draft.folder_uidvalidity) ||
    !nonEmptyString(draft.message_uid) ||
    !nonEmptyString(draft.sender) ||
    !nonEmptyString(draft.subject) ||
    !nonEmptyString(draft.body) ||
    !claimedScopeIsUnambiguous(draft.body) ||
    draft.attachments.length !== 1 ||
    !validAttachment(draft.attachments[0]!)
  ) {
    return undefined;
  }
  const recipient = normalizedRecipient(draft, allowed);
  if (!recipient) return undefined;
  const attachment = draft.attachments[0]!;
  return { draft, recipient, attachment, identity: candidateIdentity(draft, recipient, attachment) };
}

function bridgeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function processTimedOut(error: unknown): boolean {
  return isRecord(error) && (error.code === "ETIMEDOUT" || error.killed === true);
}

function decodeBridgeDraft(value: unknown): MailboxDraft {
  if (!isRecord(value)) throw new MailboxError("mailbox_invalid_response");
  const required = ["mailbox_account", "folder_uidvalidity", "message_uid", "sender", "subject", "body"] as const;
  const fields = Object.fromEntries(required.map((key) => [key, bridgeString(value[key])])) as Record<typeof required[number], string | undefined>;
  if (required.some((key) => !nonEmptyString(fields[key]))) throw new MailboxError("mailbox_invalid_response");
  if (!Array.isArray(value.recipients) || !value.recipients.every(nonEmptyString)) {
    throw new MailboxError("mailbox_invalid_response");
  }
  if (!Array.isArray(value.attachments)) throw new MailboxError("mailbox_invalid_response");
  const attachments = value.attachments.map((rawAttachment): MailboxAttachment => {
    if (!isRecord(rawAttachment) || !nonEmptyString(rawAttachment.filename) || !nonEmptyString(rawAttachment.bytes_base64)) {
      throw new MailboxError("mailbox_invalid_response");
    }
    const encoded = rawAttachment.bytes_base64;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw new MailboxError("mailbox_invalid_response");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new MailboxError("mailbox_invalid_response");
    return { filename: rawAttachment.filename, bytes: new Uint8Array(bytes) };
  });
  return {
    mailbox_account: fields.mailbox_account!,
    folder_uidvalidity: fields.folder_uidvalidity!,
    message_uid: fields.message_uid!,
    sender: fields.sender!,
    recipients: [...value.recipients],
    subject: fields.subject!,
    body: fields.body!,
    attachments,
  };
}

/** Provider-neutral adapter for the supported WSL Gmail/IMAP setup. */
export class GmailImapMailbox implements MailboxSource {
  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly cwd: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly bridgeTimeoutMs: number;

  constructor(options: GmailImapMailboxOptions = {}) {
    this.pythonBin = options.pythonBin ?? process.env.PEEL_PYTHON_BIN ?? "python3";
    this.scriptPath = options.scriptPath ?? process.env.PEEL_MAILBOX_FETCH_SCRIPT ?? DEFAULT_IMAP_SCRIPT;
    this.cwd = options.cwd ?? process.cwd();
    this.environment = { ...process.env, ...(options.environment ?? {}) };
    this.bridgeTimeoutMs = options.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.bridgeTimeoutMs) || this.bridgeTimeoutMs <= 0) {
      throw new RangeError("mailbox bridge timeout must be positive");
    }
  }

  async listDrafts(): Promise<readonly MailboxDraft[]> {
    let stdout: string;
    try {
      const result = await execFileAsync(this.pythonBin, [this.scriptPath], {
        cwd: this.cwd,
        env: this.environment,
        encoding: "utf8",
        maxBuffer: MAX_MAILBOX_RESPONSE_BYTES,
        timeout: this.bridgeTimeoutMs,
        killSignal: "SIGKILL",
      });
      stdout = result.stdout;
    } catch (error) {
      throw new MailboxError(processTimedOut(error) ? "mailbox_timeout" : "mailbox_unavailable");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(stdout) as unknown;
    } catch {
      throw new MailboxError("mailbox_invalid_response");
    }
    if (
      !isRecord(payload) ||
      payload.version !== API_VERSION ||
      (payload.draft !== null && payload.draft !== undefined && !isRecord(payload.draft))
    ) {
      throw new MailboxError("mailbox_invalid_response");
    }
    if (payload.draft === null || payload.draft === undefined) return [];
    return [decodeBridgeDraft(payload.draft)];
  }
}

/** Deterministic fake IMAP source used by the watcher’s public-boundary tests. */
export class FakeImapMailbox implements MailboxSource {
  readonly listCalls: number[] = [];
  nextError?: MailboxErrorCode;
  private drafts: MailboxDraft[];

  constructor(drafts: readonly MailboxDraft[] = []) {
    this.drafts = drafts.map(cloneDraft);
  }

  setDrafts(drafts: readonly MailboxDraft[]): void {
    this.drafts = drafts.map(cloneDraft);
  }

  async listDrafts(): Promise<readonly MailboxDraft[]> {
    this.listCalls.push(this.listCalls.length + 1);
    if (this.nextError) {
      const code = this.nextError;
      this.nextError = undefined;
      throw new MailboxError(code);
    }
    return this.drafts.map(cloneDraft);
  }
}

export class MailboxWatcher {
  private readonly daemon: PeelDaemon;
  private readonly mailbox: MailboxSource;
  private readonly allowedRecipients: ReadonlySet<string>;
  private readonly pollIntervalMs: number;
  private readonly onResult?: (result: MailboxPollResult) => void;
  private inFlight?: Promise<MailboxPollResult>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(options: MailboxWatcherOptions) {
    if (options.allowedRecipients.length === 0) throw new Error("at least one allowed recipient is required");
    if (options.pollIntervalMs !== undefined && (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0)) {
      throw new RangeError("mailbox poll interval must be positive");
    }
    this.daemon = options.daemon;
    this.mailbox = options.mailbox;
    this.allowedRecipients = new Set(options.allowedRecipients.map((recipient) => recipient.trim().toLowerCase()));
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.onResult = options.onResult;
  }

  poll(): Promise<MailboxPollResult> {
    if (this.stopped) return Promise.resolve({ status: "error", error_code: "watcher_stopped" });
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.pollOnce()
      .catch(() => ({ status: "error", error_code: "watcher_failed" } satisfies MailboxPollResult))
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = (): void => {
      void this.poll().then((result) => {
        try {
          this.onResult?.(result);
        } catch {
          // A logging/notification callback cannot change the safety result.
        }
      });
    };
    tick();
    this.timer = setInterval(tick, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const inFlight = this.inFlight;
    return inFlight ? inFlight.then(() => undefined, () => undefined) : Promise.resolve();
  }

  private async pollOnce(): Promise<MailboxPollResult> {
    let drafts: readonly MailboxDraft[];
    try {
      drafts = await this.mailbox.listDrafts();
    } catch (error) {
      return { status: "error", error_code: error instanceof MailboxError ? error.code : "mailbox_unavailable" };
    }
    if (this.stopped) return { status: "error", error_code: "watcher_stopped" };
    if (drafts.length === 0) return { status: "idle" };

    const candidate = drafts
      .map((draft) => eligibleDraft(draft, this.allowedRecipients))
      .find((draft): draft is EligibleDraft => draft !== undefined);
    if (!candidate) return { status: "ignored", error_code: "ineligible_draft" };

    const existing = this.daemon.getRunForTrigger(candidate.identity);
    if (
      existing?.envelope_revision_hash === candidate.identity.envelope_revision_hash &&
      this.daemon.hasRunMaterialization(existing)
    ) {
      return { status: "deduplicated", identity: candidate.identity, run: existing };
    }

    const activeRuns = this.daemon.getActiveRuns();
    if (activeRuns.length > 0 && !activeRuns.some((run) => run.run_id === existing?.run_id)) {
      return {
        status: "blocked",
        identity: candidate.identity,
        run: activeRuns[0],
        error_code: "active_run_exists",
      };
    }
    if (existing?.state === "disclosed") {
      return {
        status: "error",
        identity: candidate.identity,
        run: existing,
        error_code: "run_already_disclosed",
      };
    }

    let artifact: ArtifactReference;
    try {
      artifact = this.daemon.uploadArtifact(candidate.attachment.bytes, candidate.attachment.filename);
    } catch {
      return { status: "error", identity: candidate.identity, error_code: "artifact_upload_failed" };
    }
    let stage: Awaited<ReturnType<PeelDaemon["execute"]>>;
    try {
      stage = await this.daemon.execute({
        version: API_VERSION,
        command: "stage",
        command_id: newId(),
        expected_state: "new",
        trigger: candidate.identity,
        envelope: {
          sender: candidate.draft.sender.trim(),
          recipient: candidate.recipient,
          subject: candidate.draft.subject.trim(),
          body: candidate.draft.body,
          attachment: artifact,
        },
      });
    } catch {
      return { status: "error", identity: candidate.identity, error_code: "watcher_failed" };
    }
    if (!stage.ok) {
      return {
        status: "error",
        identity: candidate.identity,
        run: stage.run,
        error_code: stage.error.code,
      };
    }
    return {
      status: stage.deduplicated ? "deduplicated" : "triggered",
      identity: candidate.identity,
      run: stage.run,
    };
  }
}
