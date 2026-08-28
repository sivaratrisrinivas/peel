# Run one local Peel daemon

One TypeScript daemon owns the mailbox watcher, local SQLite state, artifact registry, and localhost Streamable HTTP MCP server. It invokes the Python engine through the versioned CLI contract. This minimizes demo processes while keeping TrueForge and Daytona as visible external runtime dependencies.
