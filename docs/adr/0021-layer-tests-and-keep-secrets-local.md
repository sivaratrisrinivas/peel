# Layer tests and keep secrets local

The engine uses pytest for deterministic Attack, Repair, and Verification coverage. TypeScript uses Vitest for watcher, state-machine, idempotency, and MCP behavior. CI uses fake IMAP and SMTP, while a separately invoked end-to-end suite exercises owned Gmail accounts, Cerebras, TrueForge, and Daytona. Only `.env.example` is committed; `.env` is ignored, startup validates required configuration, and errors redact credentials. Provider credentials remain separate and least-privilege where supported.
