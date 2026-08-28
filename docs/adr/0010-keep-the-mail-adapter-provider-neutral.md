# Keep the mail adapter provider-neutral

The mail MCP contract will remain provider-neutral through IMAP and SMTP environment configuration. The demo will use two dedicated Gmail accounts with 2FA, app passwords, and an exact two-address allowlist after IMAP and SMTP pass the environment go/no. Provider-specific authentication details will not enter the engine or orchestration contracts.
