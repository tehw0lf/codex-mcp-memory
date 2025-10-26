# MCP Memory Server

A safe, reliable, and production-ready MCP (Model Context Protocol) server that implements long-term memory capabilities for AI assistants. Built with PostgreSQL and pgvector for efficient vector similarity search.

## Features

- **Robust Architecture**: Clean separation of concerns with dedicated classes for configuration, logging, database, embeddings, and protocol handling
- **PostgreSQL + pgvector**: Efficient vector similarity search with proper database connection pooling
- **Advanced Input Validation**: Comprehensive input sanitization and validation to prevent injection attacks
- **Configurable Security**: Content length limits, tag count limits, and other security measures
- **Retry Logic**: Built-in retry mechanisms for embedding generation and database operations
- **Structured Logging**: Advanced logging system with configurable levels and MCP protocol logging
- **Graceful Shutdown**: Proper resource cleanup on shutdown signals
- **Error Boundaries**: Comprehensive error handling with proper error propagation
- **Semantic Search**: BERT-based embedding generation with similarity scoring
- **MCP Protocol 2025-06-18 Compliant**: Full compatibility with latest MCP specification
- **Client Compatibility**: Automatic client detection with workarounds for known client bugs

## Prerequisites

1. PostgreSQL 14+ with pgvector extension installed:

```bash
# In your PostgreSQL instance:
CREATE EXTENSION vector;
```

2. Node.js 18+

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment variables:

**Option A: Using .env file (for development)**
Copy `.env.example` to `.env` and adjust the values:

```bash
cp .env.example .env
```

**Option B: Using codex-config.toml (recommended for Codex CLI)**
Configure environment variables in your `codex-config.toml` as shown in the MCP Configuration section.

Required configuration:

```bash
# Database Configuration (Required)
DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# Optional configurations with defaults
LOG_LEVEL=info                          # error, warn, info, debug
DB_MAX_POOL_SIZE=20                     # Database connection pool size
SEARCH_DEFAULT_LIMIT=10                 # Default search result limit
MAX_CONTENT_LENGTH=10000                # Max content size for security
MAX_TAGS_COUNT=20                       # Max number of tags per memory
MCP_DEBUG_LOG_PATH=/tmp/memory-debug.log # MCP debug logging path
MCP_PROTOCOL_VERSION=2025-06-18         # MCP protocol version (default: 2024-11-05, recommended: 2025-06-18)
NODE_ENV=production                      # Runtime environment
```

See `.env.example` for all available configuration options.

3. Initialize the database:
   The database schema is automatically initialized when the server starts. Ensure your PostgreSQL database has the pgvector extension enabled.

4. Start the server:

```bash
npm start
```

## Architecture

The refactored server follows a clean, modular architecture:

- **Config**: Environment variable validation and configuration management
- **Logger**: Structured logging with configurable levels and MCP protocol support
- **Validator**: Input sanitization and validation with security limits
- **DatabaseManager**: Connection pooling, query handling, and schema management
- **EmbeddingsManager**: BERT model initialization and embedding generation with retries
- **MCPProtocolHandler**: MCP protocol compliance and response formatting
- **MemoryServer**: Main coordination class with graceful shutdown

## MCP Configuration

### Adding the MCP Server to Codex CLI

To use this memory server with Codex CLI, add the following configuration to your `codex-config.toml`:

```toml
[mcp_servers.memory]
command = "node"
args = ["/path/to/your/memory/src/server.js"]

[mcp_servers.memory.env]
# Database configuration (required)
DATABASE_URL = "postgresql://user:password@localhost:port/dbname"

# Optional: Custom debug log path (defaults to repo memory-debug.log)
MCP_DEBUG_LOG_PATH = "/tmp/memory-debug.log"

# Recommended runtime
NODE_ENV = "production"
```

Replace `/path/to/your/memory/src/server.js` with the actual absolute path to your server file.

The server communicates over stdio using the MCP JSON‑RPC protocol and is launched by Codex CLI when needed.

### Available MCP Tools

The server provides three MCP tools for memory operations:

1. **memory_create** - Create a new memory entry
   - `type`: Type of memory (string, required)
   - `content`: Content to store (object, required)
   - `source`: Source of the memory (string, required)
   - `confidence`: Confidence score between 0 and 1 (number, required)
   - `tags`: Optional tags (array of strings, optional)

2. **memory_search** - Search for memories using semantic similarity
   - `query`: Search query (string, required)
   - `type`: Optional type filter (string, optional)
   - `tags`: Optional tags filter (array of strings, optional)
   - `limit`: Maximum number of results to return (number, optional)

3. **memory_list** - List all memories
   - `type`: Optional type filter (string, optional)
   - `tags`: Optional tags filter (array of strings, optional)

## Memory Schema

- id: Unique identifier
- type: Type of memory (learning, experience, etc.)
- content: Actual memory content (JSON)
- source: Where the memory came from
- embedding: Vector representation of the content (384 dimensions)
- tags: Array of relevant tags
- confidence: Confidence score (0-1)
- createdAt: When the memory was created
- updatedAt: When the memory was last updated

## Agent Integration

For projects using AI agents, include an `AGENTS.md` file with the following memory policy to enable automatic memory integration:

```markdown
# Memory policy

- After each /apply, /run, file edit, migration or command execution, summarize changes and call MCP tool `memory_create`.
- Always include tags: ["repo:<repo_name>","branch:develop","svc:<service_name>"] (adjust per project).
- On new tasks, first call `memory_search` with the repo/branch tags to recall last context.
- Keep entries concise: what changed, why, artifacts, next steps.
```

This ensures AI agents automatically maintain project memory and context across sessions.

### Claude MCP

```bash
claude mcp add memory \
  --env DATABASE_URL="postgresql://user:pass@localhost:5432/db" \
  --env LOG_LEVEL=info \
  --env EMBEDDINGS_CACHE_SIZE=500 \
  -- node /abs/path/to/memory/src/server.js
```

Use resources:

- `@memory:mem://by-tags/repo:<repo-name>,svc:<service-name>`
- `@memory:mem://item/<uuid>`

## Known Issues

### Claude Desktop ResourceLink Compatibility

**Issue**: Claude Desktop (as of version 0.13.37) has a bug where it rejects spec-compliant `CallToolResult` responses containing mixed content types (e.g., `TextContent` + `ResourceLink`), even though the MCP 2025-06-18 specification explicitly allows this.

**Workaround**: The server automatically detects Claude Desktop clients (via client name during initialization) and filters out `ResourceLink` items from responses. Spec-compliant clients (Claude Code, etc.) receive full responses with ResourceLinks.

**Status**:

- **Local issue**: [#2](https://github.com/geranton93/codex-mcp-memory/issues/2)
- **Upstream bug report**: [modelcontextprotocol/modelcontextprotocol#1638](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1638)

**Impact**: When using Claude Desktop, you will not receive `ResourceLink` items in tool responses. Use `resources/read` with `mem://` URIs directly if you need to fetch full memory content.

This workaround will be removed once the Claude Desktop bug is fixed.
