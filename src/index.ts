import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { PeelDaemon } from "./daemon.js";
import { DaytonaWorkbookEngine, FakeWorkbookEngine, InMemoryArtifactStore, SmtpDisclosureMailer } from "./adapters.js";
import { createPeelHttpServer } from "./http.js";
import { GmailImapMailbox, MailboxWatcher } from "./mailbox.js";

const recipient = process.env.PEEL_OWNED_RECIPIENT;
if (!recipient) throw new Error("PEEL_OWNED_RECIPIENT is required");

const databasePath = process.env.PEEL_DATABASE_PATH ?? ".peel/peel.sqlite";
if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
const liveMode = process.env.PEEL_LIVE_MODE === "1";
const artifacts = new InMemoryArtifactStore();

if (liveMode) {
  for (const name of ["DAYTONA_API_KEY", "SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"]) {
    if (!process.env[name]) throw new Error(`${name} is required in live mode`);
  }
}

const daemon = new PeelDaemon({
  allowedRecipients: [recipient],
  artifactStore: artifacts,
  // The non-live process is a local demo/test path. It may scan, but approved
  // Repair must execute through the fresh-sandbox Daytona adapter.
  engine: liveMode ? new DaytonaWorkbookEngine(artifacts) : new FakeWorkbookEngine(artifacts, { repairEnabled: false }),
  disclosureMailer: liveMode ? new SmtpDisclosureMailer() : undefined,
  databasePath,
});
const server = createPeelHttpServer(daemon);
const port = Number(process.env.PEEL_PORT ?? 8787);
let mailboxWatcher: MailboxWatcher | undefined;
if (process.env.PEEL_MAILBOX_WATCH === "1") {
  mailboxWatcher = new MailboxWatcher({
    daemon,
    mailbox: new GmailImapMailbox(),
    allowedRecipients: [recipient],
    pollIntervalMs: Number(process.env.PEEL_MAILBOX_POLL_INTERVAL_MS ?? 5_000),
    onResult: (result) => {
      // Keep the daemon log bounded: no draft body or attachment bytes cross
      // the watcher result boundary.
      process.stdout.write(`${JSON.stringify({
        status: result.status,
        error_code: result.error_code,
        run_id: result.run?.run_id,
        revision: result.run?.revision,
        state: result.run?.state,
        envelope_revision_hash: result.identity?.envelope_revision_hash,
        attachment_sha256: result.identity?.attachment_sha256,
      })}\n`);
    },
  });
  mailboxWatcher.start();
}
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Peel daemon listening on 127.0.0.1:${port}\n`);
});

async function shutdown(): Promise<void> {
  await mailboxWatcher?.stop();
  server.close(() => daemon.close());
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
