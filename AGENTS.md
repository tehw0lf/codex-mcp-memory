## Mental model

- The Memory Server is a **JSON-RPC 2.0** process (stdio) that exposes:
  - `memory_create` — idempotent **upsert** of structured memories.
  - `memory_search` — **semantic search** (returns ranked IDs + links).
  - `memory_list` — **filter & list** (by type/tags).
  - `resources/read` — **fetch full record** via `mem://…` resource links.
  - `prompts/list` — advertised prompt "intents" (`memory_recall`, `memory_save`) to guide your behavior.

- Default interaction loop for Claude:
  1. **Recall**: before answering, call `memory_search` with a focused query and project tags.
  2. **Read**: follow `mem://item/{id}` links via `resources/read` to load full content.
  3. **Answer** the user, citing what you pulled (optionally).
  4. **Save**: call `memory_create` with a concise, structured summary of any new, durable knowledge.

---

## Connection & initialization

Send an `initialize` request **once** at startup:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "clientInfo": { "name": "claude", "version": "1.0" }
  }
}
```

**Note:** The server supports MCP protocol version `2025-06-18` (configurable via `MCP_PROTOCOL_VERSION` env var, defaults to `2024-11-05`).

If you see error `-32002` ("Server not initialized") on later calls, repeat `initialize`.

Useful discovery calls:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"resources/list"}
{"jsonrpc":"2.0","id":4,"method":"resources/templates/list"}
{"jsonrpc":"2.0","id":5,"method":"prompts/list"}
```

---

## Tool contracts (what to send)

### `tools/call` ➜ `memory_search`

- **Input**
  - `query` _(string, required)_ — short, specific semantic query (≤1000 chars).
  - `type` _(string, optional)_ — scope by type (e.g., `"note"`, `"decision"`, `"todo"`).
  - `tags` _(string\[], optional)_ — use normalized tags like `project:alpha`, `topic:etl`.
  - `limit` _(number, optional)_ — default 10, max 100.

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "memory_search",
    "arguments": {
      "query": "deployment checklist for service-x",
      "type": "note",
      "tags": ["project:service-x", "env:prod"],
      "limit": 5
    }
  }
}
```

- **Output (important fields)**
  - `result.structuredContent[]` with `{ id, type, similarity, tags, createdAt }` (higher `similarity` is better).
  - `result.content[]` also includes `resource_link` entries you can follow with `resources/read` to fetch the full JSON content.

### `resources/read`

- **Input**: the `uri` returned by search/list, e.g. `mem://item/<id>`

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "resources/read",
  "params": {
    "uri": "mem://item/123e4567"
  }
}
```

- **Output**: `result.contents[0].text` is a JSON string of the full record.

You can also use the templates:

- `mem://recent?limit=20`
- `mem://by-tags/project:alpha,topic:etl?limit=50`
- `mem://by-type/note?limit=100`

### `tools/call` ➜ `memory_create` (idempotent upsert)

- **Input (required)**: `type`, `content`, `source`, `confidence` (0..1)
- **Optional**: `tags` (≤20; regex `^[a-z0-9:_-]{1,100}$`)
- **Content limits**: serialized JSON size ≤ `MAX_CONTENT_LENGTH` (default 10000 chars)

**Recommendation:** Always pass `content` as a JSON object. For plain text, wrap in `{ "text": "..." }`.

```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "tools/call",
  "params": {
    "name": "memory_create",
    "arguments": {
      "type": "decision",
      "content": {
        "summary": "Adopt Blue/Green deploy for service-x",
        "rationale": ["zero-downtime", "fast rollback"],
        "owners": ["alice", "bob"],
        "next_steps": ["create runbook", "add health probes"]
      },
      "source": "chat://claude/session-2025-09-17",
      "tags": ["project:service-x", "topic:release", "status:accepted"],
      "confidence": 0.9
    }
  }
}
```

- **Behavior:** Server computes a **content hash** that is stable across key order / deep structure.
  On conflict, it **merges tags** (distinct) and **keeps the max confidence**, updating `updated_at`.
  Use this to safely "save again" without creating duplicates.

### `tools/call` ➜ `memory_list`

- Use when you need a quick list without semantic search:

```json
{
  "jsonrpc": "2.0",
  "id": 13,
  "method": "tools/call",
  "params": {
    "name": "memory_list",
    "arguments": { "type": "todo", "tags": ["project:service-x"] }
  }
}
```

Then follow the `resource_link`s with `resources/read`.

---

## Tagging strategy (crucial for retrieval quality)

Normalize all tags to **lowercase** and use the allowed charset `[a-z0-9:_-]`.

Recommended patterns:

- `project:<slug>` — e.g., `project:service-x`, `project:marketing-site`
- `entity:<name>` — e.g., `entity:orders-db`, `entity:billing-api`
- `topic:<area>` — e.g., `topic:etl`, `topic:observability`
- `type:<subtype>` if you need finer grain
- `env:<scope>` — `env:dev`, `env:staging`, `env:prod`
- `status:<state>` — `status:accepted`, `status:wip`, `status:blocked`

**Always** include `project:<slug>` for cross-conversation continuity.

---

## What to save (and what not)

**Save** durable, reusable knowledge:

- Decisions, runbooks, interfaces, invariants, architectural notes, handoffs, SOPs.
- Entity facts (API endpoints, schemas, owners, SLAs).
- Non-obvious troubleshooting steps that worked.

**Do not save**:

- Secrets, creds, tokens, personal data.
- Ephemera (one-off scheduling chatter), speculative notes with low signal.
- Massive raw logs — summarize first.

**Confidence** guide:

- 0.9-1.0: Confirmed facts/decisions.
- 0.6-0.8: Strong but not absolute confidence.
- 0.3-0.5: Observations / early hypotheses (use `status:draft`).

---

## Recall patterns

- Start with **narrow tags** + focused query:
  - Good: `"blue/green deployment checklist"` + `["project:service-x","topic:release"]`
  - Weak: `"deployment"`

- If no hits:
  1. Drop `type` filter.
  2. Broaden tags (keep the project).
  3. Increase `limit` (up to 100).

- When you need content, **follow `mem://item/{id}`** with `resources/read`.

---

## Error handling & limits

- Validation errors you can fix:
  - `query` empty or >1000 chars.
  - `tags` >20 or invalid charset.
  - `content` too large (truncate/summarize).
  - Missing required fields for `memory_create`.

- Operational errors:
  - `-32002 Server not initialized` ➜ call `initialize`.
  - Embeddings/model warm-up can be slow on first call — retry with backoff if needed.
  - Database/network errors — surface a brief apology; optionally retry once.

---

## Claude-style "self-management" (recommended)

Before you answer users:

1. **Plan**: Decide whether a recall might help.
2. **Recall**: `memory_search` with strong tags.
3. **Read**: `resources/read` top-K until enough context.
4. **Answer**: Use what you read; keep the response concise.
5. **Save**: If new durable knowledge emerged, `memory_create`.

Keep `tags` consistent. Prefer structured `content` with fields users will query later.

---

## Example end-to-end

1. Search:

```json
{
  "jsonrpc": "2.0",
  "id": 21,
  "method": "tools/call",
  "params": {
    "name": "memory_search",
    "arguments": {
      "query": "rollback steps for service-x deploy",
      "tags": ["project:service-x", "topic:release"],
      "limit": 3
    }
  }
}
```

2. Read a hit:

```json
{
  "jsonrpc": "2.0",
  "id": 22,
  "method": "resources/read",
  "params": {
    "uri": "mem://item/9b5f…"
  }
}
```

3. Save a refinement:

```json
{
  "jsonrpc": "2.0",
  "id": 23,
  "method": "tools/call",
  "params": {
    "name": "memory_create",
    "arguments": {
      "type": "runbook",
      "content": {
        "title": "Service-X Rollback v2",
        "steps": [
          /* concise */
        ]
      },
      "source": "chat://claude/session-2025-09-17",
      "tags": ["project:service-x", "topic:release", "status:accepted"],
      "confidence": 0.95
    }
  }
}
```

---

## Safety & privacy

- Never store secrets/Pll; prefer references (e.g., "see vault:…", not the value).
- Summarize large blobs; keep `content` under the configured max length.
- Respect the project's retention policy if one exists.

---

## Notes on results

- `memory_search` orders by a `similarity` score (higher is better).
- The search response does **not** include full `content`. Always fetch via `resources/read`.
- Upserts are **deterministic** across `content` key order — use that to safely resave updates.

---

# agents.md — Integration Guide for Any Agent

This document is a drop-in "how to use Memory Server" for LLM agents, tools, or orchestrators.

---

## 1) Capabilities

- **Create/Upsert** (`memory_create`) — dedup by deep content hash; merges tags; max confidence wins.
- **Semantic Search** (`memory_search`) — retrieve relevant memory IDs with similarity score and links.
- **List/Filter** (`memory_list`) — quick listing by `type` and/or `tags`.
- **Read Resource** (`resources/read`) — fetch full JSON for `mem://…`.
- **Prompts Discovery** (`prompts/list`) — includes `memory_recall` & `memory_save` intents.

---

## 2) Server configuration (env)

Your runtime must set:

| Variable                 | Purpose                          | Default               |      |         |        |
| ------------------------ | -------------------------------- | --------------------- | ---- | ------- | ------ |
| `DATABASE_URL`           | **Required** Postgres connection | —                     |      |         |        |
| `LOG_LEVEL`              | \`error                          | warn                  | info | debug\` | `info` |
| `MCP_DEBUG_LOG_PATH`     | Debug log path                   | `../memory-debug.log` |      |         |        |
| `DB_MAX_POOL_SIZE`       | Pool size                        | `20`                  |      |         |        |
| `DB_IDLE_TIMEOUT`        | ms                               | `30000`               |      |         |        |
| `DB_QUERY_TIMEOUT`       | ms                               | `30000`               |      |         |        |
| `EMBEDDINGS_MODEL`       | e.g. `Xenova/all-MiniLM-L6-v2`   | that default          |      |         |        |
| `EMBEDDINGS_POOLING`     | `mean` (recommended)             | `mean`                |      |         |        |
| `EMBEDDINGS_NORMALIZE`   | `true/false`                     | `true`                |      |         |        |
| `EMBEDDINGS_MAX_RETRIES` | retries                          | `3`                   |      |         |        |
| `SEARCH_DEFAULT_LIMIT`   | default K                        | `10`                  |      |         |        |
| `SEARCH_MAX_LIMIT`       | hard cap                         | `100`                 |      |         |        |
| `MAX_CONTENT_LENGTH`     | JSON char cap                    | `10000`               |      |         |        |
| `MAX_TAGS_COUNT`         | tag cap                          | `20`                  |      |         |        |

---

## 3) Client patterns

### 3.1 Initialize once

```json
{
  "jsonrpc": "2.0",
  "id": "init",
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "clientInfo": { "name": "your-agent", "version": "1.0" }
  }
}
```

### 3.2 Save (idempotent upsert)

```json
{
  "jsonrpc": "2.0",
  "id": "save-1",
  "method": "tools/call",
  "params": {
    "name": "memory_create",
    "arguments": {
      "type": "note",
      "content": { "text": "Use /healthz for readiness; /livez for liveness" },
      "source": "agent://pipeline/step-42",
      "tags": ["project:alpha", "topic:observability", "env:prod"],
      "confidence": 0.9
    }
  }
}
```

### 3.3 Search then read

```json
{
  "jsonrpc": "2.0",
  "id": "search-1",
  "method": "tools/call",
  "params": {
    "name": "memory_search",
    "arguments": {
      "query": "readiness check endpoint for alpha",
      "tags": ["project:alpha", "topic:observability"],
      "limit": 3
    }
  }
}
```

Then:

```json
{
  "jsonrpc": "2.0",
  "id": "read-1",
  "method": "resources/read",
  "params": {
    "uri": "mem://item/<id-from-results>"
  }
}
```

### 3.4 List by tags or type

```json
{
  "jsonrpc": "2.0",
  "id": "list-1",
  "method": "tools/call",
  "params": {
    "name": "memory_list",
    "arguments": { "type": "decision", "tags": ["project:alpha"] }
  }
}
```

---

## 4) Data modeling best practices

- **Always structured JSON** in `content`. Include fields you'll query later (`summary`, `steps`, `owners`, `links`).
- **Tag consistently**. Minimum set per record:
  - `project:<slug>`
  - one or more `topic:<area>`
  - optional `status:<state>`, `env:<scope>`, `entity:<name>`

- **Break up large items**: save a summary plus references. Keep under `MAX_CONTENT_LENGTH`.
- **Choose `type` deliberately**: `note`, `decision`, `runbook`, `todo`, `spec`, `finding`, etc.
- **Confidence**: use higher values for vetted facts; lower for hypotheses. You can upsert later with higher confidence.

---

## 5) Retrieval strategy

1. Start with `project:<slug>` and a precise `query`.
2. Add `type` if it helps disambiguate.
3. Use `limit` 5–20; increase to 100 only when necessary.
4. Always fetch full content via `resources/read` before acting on it.
5. If no results:
   - remove `type`,
   - broaden `topic:*`,
   - rephrase the query (use synonyms from your domain).

---

## 6) Idempotency & updates

- Server computes a **deep, deterministic content hash** (order-insensitive) over `{type, source, content}`.
- On conflict:
  - `tags` become the distinct union,
  - `confidence` becomes the **max**,
  - `updated_at` is refreshed.

- To "edit", re-save the same record shape with updated fields; this will coalesce.

---

## 7) Validation constraints (handle proactively)

- `tags`: ≤ **20**, charset `^[a-z0-9:_-]{1,100}$`
- `query`: 1..1000 chars
- `content`: JSON-serialized length ≤ `MAX_CONTENT_LENGTH` (default 10k chars)
- `memory_create` requires: `type`, `content`, `source`, `confidence` (0..1)

If you breach limits, **summarize** or **chunk** and save multiple small memories (link them via `content.links` and a shared tag).

---

## 8) Error handling

- `-32002` — not initialized → call `initialize`.
- `-32601` — tool not found → refresh `tools/list`.
- `-32000` — general failure → backoff and retry once; if validation error, correct inputs.
- Embeddings warm-up → first call may be slower; you can **retry** per `EMBEDDINGS_MAX_RETRIES`.

Log lines may be emitted to **stderr** in JSON; they're informational.

---

## 9) Example: Node.js stdio client

```js
import { spawn } from 'node:child_process';

const srv = spawn('node', ['path/to/memory-server.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

function rpc(id, method, params) {
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}

srv.stdout.on('data', buf => {
  for (const line of buf.toString().trim().split('\n')) {
    const msg = JSON.parse(line);
    // route by msg.id / handle results
    console.log('RPC <-', msg);
  }
});

rpc('init', 'initialize', {
  protocolVersion: '2024-11-05',
  clientInfo: { name: 'agent', version: '1.0' },
});
rpc('list-tools', 'tools/list');

rpc('save1', 'tools/call', {
  name: 'memory_create',
  arguments: {
    type: 'runbook',
    content: { title: 'Restore from backup', steps: ['stop traffic', 'restore', 'verify'] },
    source: 'agent://pipeline/backup',
    tags: ['project:alpha', 'topic:resilience'],
    confidence: 0.95,
  },
});
```

---

## 10) Claude Desktop (MCP) example config

Create/update your Claude MCP config to launch the server with env:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["path/to/memory-server.js"],
      "env": {
        "DATABASE_URL": "postgres://user:pass@host:5432/db",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

Then, inside Claude, call the **memory** MCP server tools as described above.

---

## 11) Quality checklist (for agents)

- [ ] Did you **recall** before answering?
- [ ] Did you fetch **full content** via `resources/read` before acting?
- [ ] Are your **tags** normalized and include `project:<slug>`?
- [ ] Is `content` **structured** and under size limits?
- [ ] Did you **save** any new durable knowledge with appropriate `type` and `confidence`?
- [ ] On updates, did you **upsert** instead of duplicating?

---
