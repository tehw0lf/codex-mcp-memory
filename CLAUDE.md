# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server implementing long-term memory capabilities for AI assistants. It's a Node.js ES module application using PostgreSQL with pgvector for semantic search via BERT embeddings.

**Key Technologies:**

- Node.js 18+ with ES modules
- PostgreSQL 14+ with pgvector extension
- @xenova/transformers for BERT embeddings (Xenova/all-MiniLM-L6-v2)
- JSON-RPC 2.0 over stdio for MCP protocol communication

## Common Development Commands

### Starting the Server

```bash
npm start          # Start the memory server (stdio mode for MCP)
npm run dev        # Same as start (no watch mode)
```

### Code Quality & Formatting

```bash
npm run lint       # Run ESLint on all files
npm run lint:fix   # Auto-fix ESLint issues

npm run format            # Format all JS/JSON/MD files with Prettier
npm run format:check      # Check formatting without changes
```

### Pre-commit Validation

**IMPORTANT:** Always run before committing:

```bash
npm run lint && npm run format:check && npm test
```

## Architecture

The codebase is organized into focused ES modules under `src/`:

```
src/
├── index.js       # Entry point: dotenv.config() + start MemoryServer
├── config.js      # ConfigurationError + Config
├── logger.js      # Logger
├── validator.js   # ValidationError + Validator
├── database.js    # DatabaseError + DatabaseManager
├── embeddings.js  # EmbeddingsError + EmbeddingsManager
├── protocol.js    # MCPProtocolHandler
└── server.js      # MemoryServer orchestrator
```

### Core Components (in dependency order)

1. **Config** (`src/config.js`)
   - Loads and validates environment variables from `.env` file
   - Provides typed configuration objects for all subsystems
   - Uses `parseIntWithDefault()` for safe numeric config parsing with bounds

2. **Logger** (`src/logger.js`)
   - Dual output: file-based debug logs + MCP protocol log messages over stderr
   - Configurable levels: error, warn, info, debug
   - Automatically creates log directory and initializes log file

3. **Validator** (`src/validator.js`)
   - Input sanitization for all MCP tool parameters
   - Security limits: max content length (10k chars), max tags (20), tag regex validation
   - Tag normalization: lowercase, regex `^[a-z0-9:_-]{1,100}$`

4. **DatabaseManager** (`src/database.js`)
   - PostgreSQL connection pooling (pg library)
   - Schema initialization handled by Docker init SQL (not code-based migrations)
   - Three main operations: `createMemory`, `searchMemories`, `listMemories`
   - **Idempotent upserts**: `upsertMemory()` uses content hash for deduplication

5. **EmbeddingsManager** (`src/embeddings.js`)
   - Lazy initialization of Xenova transformers pipeline
   - LRU cache (default 500 entries) keyed by SHA-256 hash of text + model name
   - Retry logic (default 3 attempts) with exponential backoff
   - Converts content to text via `JSON.stringify()` for object inputs

6. **MCPProtocolHandler** (`src/protocol.js`)
   - Implements MCP protocol methods: initialize, tools/list, tools/call, resources/\*, prompts/list
   - Three tools: `memory_create`, `memory_search`, `memory_list`
   - Content hash computation using **deterministic deep stringify** (order-insensitive)
   - Resource templates: `mem://recent`, `mem://by-tags/{tags}`, `mem://by-type/{type}`, `mem://item/{id}`
   - Returns both text summary and `structuredContent` for tool responses
   - Returns `resource_link` items in search/list results for follow-up `resources/read` calls

7. **MemoryServer** (`src/server.js`)
   - Main coordination class
   - Sets up readline interface for stdio communication
   - Routes JSON-RPC 2.0 messages to appropriate handlers
   - Graceful shutdown on SIGTERM/SIGINT

### Data Flow

**Memory Creation:**

1. Validate params (Validator)
2. Generate embedding from content (EmbeddingsManager)
3. Compute content hash (MCPProtocolHandler.stableStringifyDeep)
4. Upsert to DB (DatabaseManager.upsertMemory)
   - On conflict: merge tags (distinct), max confidence, update timestamp

**Memory Search:**

1. Validate query (Validator)
2. Generate embedding from query (EmbeddingsManager)
3. Vector similarity search in DB (uses pgvector `<#>` operator for cosine distance)
4. Return sorted results with similarity scores + resource links

**Resource Read:**

1. Parse `mem://` URI
2. Query DB by ID, tags, or type filter
3. Return full JSON content (including the `content` field)

## Configuration

All configuration via environment variables (loaded from `.env` file):

**Required:**

- `DATABASE_URL` - PostgreSQL connection string with pgvector extension enabled

**Optional (with sensible defaults):**

- `LOG_LEVEL` - error, warn, info (default), debug
- `MCP_DEBUG_LOG_PATH` - Log file path (default: `../memory-debug.log` relative to src/)
- `DB_MAX_POOL_SIZE` - Connection pool size (default: 20, range: 1-100)
- `EMBEDDINGS_MODEL` - HuggingFace model name (default: Xenova/all-MiniLM-L6-v2)
- `EMBEDDINGS_CACHE_SIZE` - LRU cache size (default: 500)
- `SEARCH_DEFAULT_LIMIT` - Default search results (default: 10, range: 1-100)
- `MAX_CONTENT_LENGTH` - Content size limit in chars (default: 10000, range: 1-100000)
- `MAX_TAGS_COUNT` - Max tags per memory (default: 20, range: 1-100)

See `.env.example` for full list with descriptions.

## Database Schema

The schema is initialized by Docker (`docker/db/00-init.sql`), not by application code. Key table:

**memories** table:

- `id` (UUID, primary key)
- `type` (text) - Memory category
- `content` (jsonb) - Structured memory data
- `source` (text) - Origin identifier
- `embedding` (vector(384)) - BERT embedding for semantic search
- `tags` (text[]) - Array of normalized tags
- `confidence` (numeric 0-1) - Confidence score
- `content_hash` (bytea, unique) - SHA-256 for deduplication
- `created_at`, `updated_at` (timestamptz)

Index: `embedding_idx` (HNSW for fast vector search)

## MCP Protocol Integration

This server communicates via stdio using JSON-RPC 2.0 and implements **MCP Protocol version 2025-06-18**. It's designed to be launched by MCP clients (Codex CLI, Claude Desktop).

**Protocol Version:** 2025-06-18 (configurable via `MCP_PROTOCOL_VERSION` env var)

**Initialization sequence:**

1. Client sends `initialize` request with protocol version
2. Server responds with capabilities (tools, resources, prompts, logging) and protocol version
3. Client sends `notifications/initialized` notification
4. Server is ready for tool calls

**Protocol Compliance:**

- ✅ Structured content responses (`structuredContent` as object with `items` property)
- ✅ Resource links in tool responses (spec-compliant, but see Known Issues)
- ✅ All required fields for ResourceLink type (`type`, `uri`, `name`)

**Available Tools:**

- `memory_create` - Create/upsert memory (idempotent via content hash)
- `memory_search` - Semantic search with similarity ranking
- `memory_list` - Filter by type/tags without semantic search

**Resource URIs:**

- `mem://recent?limit=N` - Most recent memories
- `mem://by-tags/tag1,tag2?limit=N` - Filter by tags
- `mem://by-type/{type}?limit=N` - Filter by type
- `mem://item/{id}` - Single memory by UUID

## Key Implementation Details

### Content Hash & Idempotency

The server uses **deterministic deep stringification** (`MCPProtocolHandler.stableStringifyDeep` in `src/protocol.js`) that:

- Sorts object keys at every nesting level
- Filters out undefined values
- Handles arrays and primitives consistently
- Creates stable SHA-256 hash from `type::source::content`

This enables **idempotent upserts**: calling `memory_create` with identical content (regardless of key order) will:

- Merge tags (distinct union)
- Update confidence to max(old, new)
- Refresh `updated_at`

### Embeddings Caching

Cache key format: `SHA256(text)::model_name` (`EmbeddingsManager.cacheKey` in `src/embeddings.js`)

This prevents cache collisions when model changes. Cache uses LRU eviction with configurable size.

### Vector Search

Uses pgvector's **negative inner product** operator (`<#>`) which is equivalent to cosine distance when embeddings are normalized (default). Similarity score is computed as `1 - distance` (`DatabaseManager.buildSearchQuery` in `src/database.js`).

### Error Handling

- ConfigurationError: Missing required env vars
- ValidationError: Invalid inputs (caught and returned as JSON-RPC errors)
- DatabaseError: DB operations (logged with original error)
- EmbeddingsError: Model/embedding failures (includes retry logic)

All errors are logged to debug file and returned to client as JSON-RPC error responses.

## Testing Approach

### Automated Tests (Vitest)

```bash
npm test                 # Unit tests (113 tests across all 5 src/ modules)
npm run test:integration # Integration tests (requires DATABASE_URL)
npm run test:all         # Unit + integration
npm run test:coverage    # Unit tests with v8 coverage report
```

Integration tests auto-skip when `DATABASE_URL` is not set.

### Manual Testing

1. **Start PostgreSQL with pgvector:**

   ```bash
   docker-compose up -d
   ```

2. **Configure `.env`:**

   ```bash
   cp .env.example .env
   # Edit DATABASE_URL to match docker-compose settings
   ```

3. **Start server and test with MCP client** (Codex CLI or manual JSON-RPC over stdin)

4. **Verify via database queries:**
   ```bash
   psql $DATABASE_URL -c "SELECT id, type, tags, confidence FROM memories;"
   ```

## Common Issues

1. **Server not responding**: Check that PostgreSQL is running and pgvector extension is enabled

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

2. **Embeddings initialization slow**: First call downloads ~90MB model (cached in `~/.cache/huggingface`)

3. **Validation errors on tags**: Ensure tags match regex `^[a-z0-9:_-]{1,100}$` (lowercase, no special chars except `:`, `_`, `-`)

4. **Memory not found after creation**: Check logs for upsert behavior - might be updating existing record with same content hash

5. **"Unsupported format" error in Claude Desktop**: This is a known Claude Desktop bug (as of 2025-10-10) where it doesn't properly handle mixed content types (TextContent + ResourceLink) in tool responses, even though the MCP 2025-06-18 spec explicitly allows this. **TEMPORARY WORKAROUND**: The server now detects Claude Desktop (client name: "claude-ai") and automatically removes ResourceLink items from responses, providing only TextContent. Claude Code and other spec-compliant clients receive the full response with ResourceLinks. See `CLAUDE_DESKTOP_BUG_REPORT.md` for bug details. This workaround will be removed once the bug is fixed.

## Making Changes

### Adding New Configuration Options

1. Add to `.env.example` with description
2. Add parsing in `Config.initializeX()` method (`src/config.js`)
3. Use `parseIntWithDefault()` for numeric values with validation

### Adding New MCP Tools

1. Define schema in `handleListTools()` (`src/protocol.js`)
2. Implement handler method in `MCPProtocolHandler` class (`src/protocol.js`)
3. Add case in `handleToolCall()` switch (`src/protocol.js`)
4. Add validation method in `Validator` class (`src/validator.js`)

### Adding New Resource Templates

1. Add template in `handleListResourceTemplates()` (`src/protocol.js`)
2. Implement parsing in `handleReadResource()` / `getResourcePayload()` (`src/protocol.js`)
3. Add database query method if needed (`src/database.js`)

## Related Documentation

- **AGENTS.md**: Comprehensive agent integration guide with protocol examples, tagging strategies, and quality checklist
- **README.md**: Setup instructions, architecture overview, and MCP configuration examples
- **.env.example**: All available configuration options with descriptions
