# Memory policy
- After each /apply, /run, file edit, migration or command execution, summarize changes and call MCP tool `memory_create`.
- Always include tags: ["repo:<repo_name>","branch:develop","svc:executor-evm"] (adjust per project).
- On new tasks, first call `memory_search` with the repo/branch tags to recall last context.
- Keep entries concise: what changed, why, artifacts, next steps.