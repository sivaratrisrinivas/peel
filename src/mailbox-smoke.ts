import { InMemoryArtifactStore, PeelDaemon } from "./daemon.js";
import { GmailImapMailbox, MailboxWatcher } from "./mailbox.js";

const recipient = process.env.PEEL_OWNED_RECIPIENT;
if (!recipient) {
  process.stdout.write(JSON.stringify({ status: "failed", failure_code: "mailbox_configuration_missing" }) + "\n");
  process.exitCode = 2;
} else {
  const artifacts = new InMemoryArtifactStore();
  const daemon = new PeelDaemon({
    allowedRecipients: [recipient],
    artifactStore: artifacts,
    databasePath: process.env.PEEL_MAILBOX_SMOKE_DATABASE ?? ":memory:",
  });
  const watcher = new MailboxWatcher({
    daemon,
    mailbox: new GmailImapMailbox(),
    allowedRecipients: [recipient],
  });

  try {
    const first = await watcher.poll();
    const second = first.status === "triggered" || first.status === "deduplicated"
      ? await watcher.poll()
      : undefined;
    const evidence = {
      schema_version: "1",
      smoke: "mailbox_trigger",
      first_poll_status: first.status,
      second_poll_status: second?.status ?? "not_run",
      run_id: first.run?.run_id ?? "",
      revision: first.run?.revision ?? 0,
      same_run: Boolean(first.run && second?.run && first.run.run_id === second.run.run_id),
      one_run_started: first.status === "triggered" && second?.status === "deduplicated",
      error_code: first.error_code ?? second?.error_code ?? "",
    };
    process.stdout.write(JSON.stringify(evidence) + "\n");
    process.exitCode = evidence.one_run_started ? 0 : 2;
  } finally {
    daemon.close();
  }
}
