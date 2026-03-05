# MCP Memory Server

A safe, reliable, and production-ready MCP (Model Context Protocol) server that implements long-term memory capabilities for AI assistants. Built with PostgreSQL and pgvector for efficient vector similarity search.

## Features

- **Semantic Search**: BERT-based embedding generation with similarity scoring
- **Idempotent Upserts**: Duplicate detection via SHA-256 content hashing
- **MCP Protocol 2025-06-18 Compliant**: Full compatibility with latest MCP specification
- **Client Compatibility**: Automatic client detection with workarounds for known client bugs
- **Robust Architecture**: Clean separation of concerns with dedicated modules for configuration, logging, database, embeddings, and protocol handling
- **Advanced Input Validation**: Comprehensive input sanitization with content length limits, tag count limits, and injection protection
- **Retry Logic**: Built-in retry mechanisms with exponential backoff for embedding generation
- **Structured Logging**: Configurable log levels with MCP protocol logging over stderr
- **Graceful Shutdown**: Proper resource cleanup on SIGTERM/SIGINT

## Quick Start

### 1. Start the database

```bash
docker-compose up -d
```

This starts PostgreSQL 16 with pgvector and the automatic backup service.

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit DATABASE_URL and POSTGRES_PASSWORD to match your docker-compose setup
```

### 4. Add to your MCP client

See [MCP Configuration](#mcp-configuration) below.

## MCP Configuration

Environment variables are loaded from `.env` automatically — no need to pass them via the MCP client config.

### Claude Code

```bash
claude mcp add memory -- node /abs/path/to/codex-mcp-memory/src/index.js
```

Use resources in Claude Code:

- `@memory:mem://by-tags/repo:<repo-name>,svc:<service-name>`
- `@memory:mem://item/<uuid>`

### Codex CLI

Add to your `codex-config.toml`:

```toml
[mcp_servers.memory]
command = "node"
args = ["/abs/path/to/codex-mcp-memory/src/index.js"]
```

## Available Tools

1. **memory_create** — Create or upsert a memory (idempotent via content hash)
   - `type`: Memory category (string, required)
   - `content`: Content to store (object, required)
   - `source`: Origin identifier (string, required)
   - `confidence`: Score between 0 and 1 (number, required)
   - `tags`: Tags for filtering (array of strings, optional)

2. **memory_search** — Semantic search with similarity ranking
   - `query`: Search query (string, required)
   - `type`: Type filter (string, optional)
   - `tags`: Tags filter (array of strings, optional)
   - `limit`: Max results (number, optional)

3. **memory_list** — List memories without semantic search
   - `type`: Type filter (string, optional)
   - `tags`: Tags filter (array of strings, optional)

4. **memory_get** — Retrieve a single memory by ID
   - `id`: UUID of the memory (string, required)

### Resource URIs

- `mem://recent?limit=N` — Most recent memories
- `mem://by-tags/tag1,tag2?limit=N` — Filter by tags
- `mem://by-type/{type}?limit=N` — Filter by type
- `mem://item/{id}` — Single memory by UUID

## Agent Integration

Include this memory policy in your `AGENTS.md` or `CLAUDE.md` to enable automatic memory integration:

```markdown
# Memory policy

- After each /apply, /run, file edit, migration or command execution, summarize changes and call MCP tool `memory_create`.
- Always include tags: ["repo:<repo_name>","branch:<branch>","svc:<service_name>"].
- On new tasks, first call `memory_search` with the repo/branch tags to recall last context.
- Keep entries concise: what changed, why, artifacts, next steps.
```

See `AGENTS.md` for a comprehensive integration guide with tagging strategies and examples.

## Configuration

All configuration via environment variables. See `.env.example` for the full list.

| Variable                | Default                   | Description                      |
| ----------------------- | ------------------------- | -------------------------------- |
| `DATABASE_URL`          | _(required)_              | PostgreSQL connection string     |
| `POSTGRES_PASSWORD`     | _(required)_              | Password for docker-compose      |
| `LOG_LEVEL`             | `info`                    | `error`, `warn`, `info`, `debug` |
| `DB_MAX_POOL_SIZE`      | `20`                      | Connection pool size (1–100)     |
| `EMBEDDINGS_MODEL`      | `Xenova/all-MiniLM-L6-v2` | HuggingFace model name           |
| `EMBEDDINGS_CACHE_SIZE` | `500`                     | LRU cache entries                |
| `SEARCH_DEFAULT_LIMIT`  | `10`                      | Default search results (1–100)   |
| `MAX_CONTENT_LENGTH`    | `10000`                   | Content size limit in chars      |
| `MAX_TAGS_COUNT`        | `20`                      | Max tags per memory              |
| `BACKUP_RETENTION_DAYS` | `7`                       | Days to keep automatic backups   |
| `MCP_DEBUG_LOG_PATH`    | `../memory-debug.log`     | Debug log file path              |
| `MCP_PROTOCOL_VERSION`  | `2025-06-18`              | MCP protocol version             |

> **Note:** The first start downloads the embedding model (~90 MB, cached in `~/.cache/huggingface`).

## Backup & Restore

The Docker setup includes an automatic backup service that runs daily at 2:00 AM, storing compressed dumps in `./backups/`.

### Restore from Backup

```bash
# Stop the MCP server / disconnect from MCP clients first

source .env && PGPASSWORD=$POSTGRES_PASSWORD pg_restore \
  --host=localhost --port=5432 \
  --username=postgres --dbname=mcp_memory \
  --clean --if-exists \
  backups/memories_YYYY-MM-DD_HHMMSS.dump
```

Or via Docker:

```bash
docker exec -i mcp-memory-db pg_restore \
  -U postgres -d mcp_memory \
  --clean --if-exists \
  < backups/memories_YYYY-MM-DD_HHMMSS.dump
```

## Known Issues

### Claude Desktop ResourceLink Compatibility

**Issue**: Claude Desktop (≤0.13.37) rejects spec-compliant `CallToolResult` responses containing mixed content types (`TextContent` + `ResourceLink`), even though MCP 2025-06-18 explicitly allows this.

**Workaround**: The server automatically detects Claude Desktop and filters out `ResourceLink` items. Spec-compliant clients (Claude Code, Codex CLI) receive full responses.

**Status**: [upstream bug report](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1638) — workaround will be removed once fixed.

## Development

```bash
npm run lint          # ESLint
npm run format        # Prettier
npm test              # Unit tests (113 tests)
npm run test:all      # Unit + integration tests (requires DATABASE_URL)
npm run test:coverage # Coverage report
```

See `CLAUDE.md` for architecture details and contribution guidelines.
