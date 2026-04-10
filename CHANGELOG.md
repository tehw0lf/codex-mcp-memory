# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2026-04-10

### Added

- **Benchmark**: Evaluated on [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025) — 90.2% R@5 retrieval, 38.3% end-to-end QA accuracy with GPT-5 as judge over 470 non-abstention questions
- **Benchmark scripts**: `scripts/longmemeval_eval.py` and `scripts/requirements-benchmark.txt` for reproducing results
- **Benchmark results**: Raw results in `results/` directory

### Changed

- **Dependencies**: Updated dev dependencies (ajv, brace-expansion, flatted, js-yaml, minimatch, picomatch, vite) via `npm audit fix`

## [0.3.2] - 2026-03-05

### Fixed

- **Limit coercion**: `validateAndParseLimit()` now coerces `limit` from string to integer to handle MCP client serialization quirks (e.g. clients sending `"10"` instead of `10`)
- **Tool schema**: `memory_search` inputSchema and `memory_recall` prompt schema now declare `limit` as `oneOf[number, string]`
- **Tests**: 2 new unit tests covering string coercion and invalid string rejection for `limit` (115 total)

## [0.3.1] - 2026-03-05

### Fixed

- **Confidence coercion**: Runtime now coerces `confidence` from string to number to handle MCP client serialization quirks (e.g. Codex CLI sending `"0.9"` instead of `0.9`)
- **Tool schema**: `memory_create` and `memory_update` schemas now declare `confidence` as `oneOf[number, string]` to match the runtime behavior and prevent client-side validation errors
- **README/docs**: Added missing `memory_get` tool, removed redundant env vars from config examples, added security note about secrets in `.env`, restructured for operator-first flow

## [0.3.0] - 2026-03-04

### Added

- **Test suite** using Vitest with 113 passing unit tests across all modules:
  - `test/unit/config.test.js` — `Config` env var parsing, defaults, clamping, `ConfigurationError`
  - `test/unit/validator.test.js` — `Validator` for all four MCP tools, tag sanitization, edge cases
  - `test/unit/embeddings.test.js` — `EmbeddingsManager` LRU cache, retry logic, model mock via `@xenova/transformers`
  - `test/unit/database.test.js` — `DatabaseManager` query building, CRUD, error wrapping (pg mocked as class)
  - `test/unit/protocol.test.js` — `MCPProtocolHandler` hash stability, client detection, tool routing, response shapes
  - `test/integration/database.integration.test.js` — skips automatically when `DATABASE_URL` is unset; tests upsert idempotency, search/filter, list ordering against real Postgres
- **`vitest.config.js`** with v8 coverage provider (lcov + text reporters)
- **npm scripts**: `test` (unit), `test:integration`, `test:all`, `test:coverage`
- **ESLint override** for `test/**` files: `max-lines-per-function` and `max-params` disabled (impractical for describe/it blocks)

### Changed

- `package.json` devDependencies: added `vitest` and `@vitest/coverage-v8`

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
