import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { PeelDaemon } from "./daemon.js";
import { createPeelHttpServer } from "./http.js";

const recipient = process.env.PEEL_OWNED_RECIPIENT;
if (!recipient) throw new Error("PEEL_OWNED_RECIPIENT is required");

const databasePath = process.env.PEEL_DATABASE_PATH ?? ".peel/peel.sqlite";
if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

const daemon = new PeelDaemon({
  allowedRecipients: [recipient],
  databasePath,
});
const server = createPeelHttpServer(daemon);
const port = Number(process.env.PEEL_PORT ?? 8787);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Peel daemon listening on 127.0.0.1:${port}\n`);
});

function shutdown(): void {
  server.close(() => daemon.close());
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
