# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-03-04

### Changed

- **Modular architecture**: Split monolithic `src/server.js` (~1500 lines) into focused ES modules:
  - `src/index.js` — entry point (dotenv + server bootstrap)
  - `src/config.js` — `Config` class with typed env var loading and validation
  - `src/logger.js` — `Logger` with dual output (file + MCP stderr)
  - `src/validator.js` — `Validator` with input sanitization and security limits
  - `src/database.js` — `DatabaseManager` with connection pooling and queries
  - `src/embeddings.js` — `EmbeddingsManager` with LRU cache and retry logic
  - `src/protocol.js` — `MCPProtocolHandler` for JSON-RPC routing, tools, resources
  - `src/server.js` — `MemoryServer` orchestrator (~180 lines)
- `package.json` entry point updated to `src/index.js`
- `eslint.config.js` updated to reflect ES module globals
- `CLAUDE.md` and `README.md` updated with new module structure

## [0.1.1] - 2026-03-04

### Fixed

- **`POSTGRES_PASSWORD` now defined in `.env`**: Previously the variable was only consumed from the shell environment (risk of exposure in shell history). It is now documented and set in `.env` / `.env.example` alongside `DATABASE_URL`, so `docker-compose up` works without any manual `export`.
- **README restore command**: The `pg_restore` example no longer hard-codes a password in the command line; it now sources `POSTGRES_PASSWORD` from `.env` via `source .env`.

## [0.1.0] - 2026-03-04

### Added

- **MCP Memory Server** — initial production-ready release
- **PostgreSQL + pgvector** backend for efficient vector similarity search
- **BERT embeddings** via `@xenova/transformers` (Xenova/all-MiniLM-L6-v2) with LRU cache and retry logic
- **Three MCP tools**: `memory_create`, `memory_search`, `memory_list`
- **`memory_get` tool** for fetching full memory content by UUID
- **Idempotent upserts** via deterministic content hashing (SHA-256 over deep-sorted content)
- **MCP Protocol 2025-06-18** compliance with structured content responses and resource links
- **Resource URIs**: `mem://recent`, `mem://by-tags/{tags}`, `mem://by-type/{type}`, `mem://item/{id}`
- **Claude Desktop workaround**: automatic detection and filtering of ResourceLink items for buggy clients
- **Docker Compose setup** with `pgvector/pgvector:pg16` image and automatic schema initialization
- **Automatic backup service**: daily pg_dump at 02:00 with configurable retention (`BACKUP_RETENTION_DAYS`)
- **Comprehensive input validation**: content length limits, tag count limits, tag regex enforcement
- **Structured logging** with configurable levels and MCP protocol log messages over stderr
- **Graceful shutdown** on SIGTERM/SIGINT with proper resource cleanup
- **Tag normalization**: lowercase, regex `^[a-z0-9:._-]{1,100}$`
- **Claude Code MCP integration** documented with `claude mcp add` command
- **Codex CLI integration** documented with `codex-config.toml` example
- **`AGENTS.md`** with agent integration guide, tagging strategies, and quality checklist

### Known Issues

- Claude Desktop (≤0.13.37) rejects mixed `TextContent` + `ResourceLink` responses — workaround active, see README
- No automated test suite yet
