import crypto from 'crypto';

export class MCPProtocolHandler {
  // Deterministic deep stringify (stable regardless of key order at any depth)
  stableStringifyDeep(v) {
    if (Array.isArray(v)) {
      return `[${v.map(x => this.stableStringifyDeep(x === undefined ? null : x)).join(',')}]`;
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v)
        .filter(k => v[k] !== undefined)
        .sort();
      return `{${keys.map(k => JSON.stringify(k) + ':' + this.stableStringifyDeep(v[k])).join(',')}}`;
    }
    return JSON.stringify(v);
  }

  // Compute content hash for memory
  computeContentHash(params) {
    const normalized = `${params.type}::${params.source}::${this.stableStringifyDeep(params.content)}`;
    return crypto.createHash('sha256').update(normalized).digest();
  }

  constructor(dependencies) {
    const { config, logger, databaseManager, embeddingsManager, validator } = dependencies;
    this.config = config;
    this.logger = logger;
    this.db = databaseManager;
    this.embeddings = embeddingsManager;
    this.validator = validator;
    this.isInitialized = false;
    // TEMPORARY WORKAROUND: Store client info to detect Claude Desktop
    // TODO: Remove when https://github.com/modelcontextprotocol/docs/issues/XXX is fixed
    this.clientInfo = null;
  }

  createErrorResponse(id, code, message) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
  }

  // TEMPORARY WORKAROUND: Detect Claude Desktop to apply compatibility fixes
  // Current fixes:
  // 1. Remove ResourceLinks from content array (mixed content types not supported)
  // 2. Include UUIDs in text output (structuredContent not accessible)
  // TODO: Remove when https://github.com/modelcontextprotocol/docs/issues/XXX is fixed
  isClaudeDesktop() {
    if (!this.clientInfo || !this.clientInfo.name) {
      return false;
    }
    const clientName = String(this.clientInfo.name).toLowerCase();
    // Claude Desktop identifies as "claude-ai", Claude Code identifies as "claude-code"
    return (
      clientName === 'claude-ai' ||
      (clientName.includes('claude') && clientName.includes('desktop'))
    );
  }

  // Enhanced createSuccessResponse for structured content (MCP 2025-06-18 compliant)
  createSuccessResponse(id, text, structured) {
    const result = {
      content: [{ type: 'text', text }],
    };

    // structuredContent must be an object, not an array (per MCP 2025-06-18 spec)
    if (structured !== undefined && structured !== null) {
      // If structured is an array, wrap it in an object with an 'items' property
      result.structuredContent = Array.isArray(structured) ? { items: structured } : structured;
    }

    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  }

  handleListResources(id) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resources: [
          {
            uri: 'mem://recent',
            name: 'Recent memories',
            description: 'Most recent 20 items',
            mimeType: 'application/json',
          },
        ],
      },
    };
  }

  handleListResourceTemplates(id) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resourceTemplates: [
          {
            uriTemplate: 'mem://by-tags/{tags}',
            name: 'Memories by tags',
            description: 'Comma-separated tags',
          },
          {
            uriTemplate: 'mem://by-type/{type}',
            name: 'Memories by type',
            description: 'Filter by type',
          },
          { uriTemplate: 'mem://item/{id}', name: 'Memory by id', description: 'Single item' },
        ],
      },
    };
  }

  async handleReadResource(id, params) {
    try {
      const { uri } = params;
      const url = new URL(uri.replace('mem://', 'http://mem/'));
      const limit = this.parseLimit(url.searchParams.get('limit'));

      const payload = await this.getResourcePayload({ url, limit, uri });

      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload) }],
        },
      };
    } catch (e) {
      this.logger.error('resources/read failed', { error: e.message });
      return this.createErrorResponse(id, -32000, `resources/read failed: ${e.message}`);
    }
  }

  parseLimit(limitParam) {
    return Math.max(1, Math.min(100, parseInt(limitParam ?? '20', 10)));
  }

  async getResourcePayload(params) {
    const { url, limit, uri } = params;
    if (url.pathname === '/recent') {
      const rows = await this.db.listMemories(undefined, undefined);
      return rows.slice(0, limit);
    }

    if (url.pathname.startsWith('/by-tags/')) {
      return this.handleByTagsResource(url, limit);
    }

    if (url.pathname.startsWith('/by-type/')) {
      return this.handleByTypeResource(url, limit);
    }

    if (url.pathname.startsWith('/item/')) {
      return this.handleItemResource(url);
    }

    throw new Error(`Unknown resource: ${uri}`);
  }

  async handleByTagsResource(url, limit) {
    const tagStr = decodeURIComponent(url.pathname.replace('/by-tags/', ''));
    const tags = tagStr
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const rows = await this.db.listMemories(undefined, tags);
    return rows.slice(0, limit);
  }

  async handleByTypeResource(url, limit) {
    const type = decodeURIComponent(url.pathname.replace('/by-type/', ''));
    const rows = await this.db.listMemories(type, undefined);
    return rows.slice(0, limit);
  }

  async handleItemResource(url) {
    const idStr = url.pathname.replace('/item/', '');
    return await this.db.getMemoryById(idStr);
  }

  handleInitialize(id, params) {
    if (this.isInitialized) {
      return this.createErrorResponse(id, -32002, 'Server already initialized');
    }

    // TEMPORARY WORKAROUND: Store client info for Claude Desktop detection
    // TODO: Remove when https://github.com/modelcontextprotocol/docs/issues/XXX is fixed
    this.clientInfo = params.clientInfo || null;

    this.logger.info('Processing initialize request', {
      clientInfo: params.clientInfo,
      clientProtocolVersion: params.protocolVersion,
    });

    const response = {
      jsonrpc: '2.0',
      id,
      result: {
        serverInfo: {
          name: this.config.server.name,
          version: this.config.server.version,
          displayName: this.config.server.displayName,
          description: this.config.server.description,
          publisher: this.config.server.publisher,
        },
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          prompts: { listChanged: false },
          logging: { levels: this.config.logging.levels },
        },
        protocolVersion: params.protocolVersion || this.config.server.protocolVersion,
      },
    };

    this.isInitialized = true;
    this.logger.info('Server initialized successfully');
    return response;
  }

  // eslint-disable-next-line max-lines-per-function
  handleListTools(id) {
    const tools = [
      {
        name: 'memory_create',
        description: 'Create a new memory entry',
        inputSchema: {
          type: 'object',
          required: ['type', 'content', 'source', 'confidence'],
          properties: {
            type: { type: 'string', description: 'Type of memory' },
            content: { type: 'object', description: 'Content to store' },
            source: { type: 'string', description: 'Source of the memory' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
            confidence: {
              oneOf: [{ type: 'number' }, { type: 'string' }],
              description: 'Confidence score between 0 and 1',
            },
          },
        },
      },
      {
        name: 'memory_search',
        description: 'Search for memories using semantic similarity',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Search query' },
            type: { type: 'string', description: 'Optional type filter' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags filter' },
            limit: {
              oneOf: [{ type: 'number' }, { type: 'string' }],
              description: 'Maximum number of results to return',
            },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  text: { type: 'string' },
                  uri: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  mimeType: { type: 'string' },
                },
              },
            },
            structuredContent: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      type: { type: 'string' },
                      similarity: { type: 'number' },
                      tags: { type: 'array', items: { type: 'string' } },
                      createdAt: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        name: 'memory_list',
        description: 'List all memories',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Optional type filter' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags filter' },
          },
        },
      },
      {
        name: 'memory_get',
        description: 'Retrieve a memory by its ID',
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Memory ID to retrieve' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  text: { type: 'string' },
                },
              },
            },
            structuredContent: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                content: { type: 'object' },
                source: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'number' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
    ];

    return {
      jsonrpc: '2.0',
      id,
      result: { tools },
    };
  }

  async handleMemoryCreate(id, params) {
    try {
      const validated = this.validator.validateMemoryCreate(params);
      const textForEmbedding = this.stableStringifyDeep(validated.content);
      const embedding = await this.embeddings.generateEmbedding(textForEmbedding);

      // Calculate content hash and use upsert
      const contentHash = this.computeContentHash(validated);
      const contentLen = JSON.stringify(validated.content).length;

      const memory = await this.db.upsertMemory({
        type: validated.type,
        content: validated.content,
        source: validated.source,
        embedding,
        tags: validated.tags,
        confidence: validated.confidence,
        contentHash,
      });

      this.logger.info('Memory upserted', {
        id: memory.id,
        type: memory.type,
        tagsCount: Array.isArray(memory.tags) ? memory.tags.length : 0,
        contentLength: contentLen,
      });

      return this.createSuccessResponse(
        id,
        [
          `Memory upserted.`,
          `ID: ${memory.id}`,
          `Type: ${memory.type}`,
          `Tags: ${JSON.stringify(memory.tags)}`,
          `Confidence: ${memory.confidence}`,
          `Created: ${memory.created_at}`,
        ].join('\n'),
        [
          {
            id: memory.id,
            type: memory.type,
            tags: memory.tags ?? [],
            confidence: memory.confidence,
            createdAt: memory.created_at,
          },
        ]
      );
    } catch (error) {
      this.logger.error('Failed to create memory', { error: error.message });
      return this.createErrorResponse(id, -32000, `Failed to create memory: ${error.message}`);
    }
  }

  // Enhanced memory search handler with resource links and structuredContent
  async handleMemorySearch(id, params) {
    const v = this.validator.validateMemorySearch(params);
    const embedding = await this.embeddings.generateEmbedding(v.query);
    const rows = await this.db.searchMemories({
      embedding,
      type: v.type,
      tags: v.tags,
      limit: v.limit,
    });

    if (!rows.length) {
      return this.createSuccessResponse(id, 'No memories found.', []);
    }

    const items = rows.map(r => ({
      id: r.id,
      type: r.type,
      similarity: r.similarity ?? null,
      tags: r.tags ?? [],
      createdAt: r.created_at,
    }));

    // TEMPORARY WORKAROUND: Claude Desktop doesn't support mixed content types
    // and cannot access structuredContent, so we need to include UUIDs in text
    // Remove ResourceLinks when Claude Desktop is detected
    // TODO: Remove when https://github.com/modelcontextprotocol/docs/issues/XXX is fixed
    const isClaudeDesktopClient = this.isClaudeDesktop();

    const lines = rows
      .map(r => {
        const baseLine = `• [${r.type}] sim=${(r.similarity ?? 0).toFixed(3)} tags=${(r.tags ?? []).join(', ')}`;
        if (isClaudeDesktopClient) {
          return `• ID: ${r.id}\n  ${baseLine.substring(2)}`; // Two-line format for readability
        }
        return baseLine;
      })
      .join('\n');

    const resourceLinks = rows.map(r => ({
      type: 'resource_link',
      uri: `mem://item/${r.id}`,
      name: `memory:${r.id}`,
      description: `Full content for ${r.id}`,
      mimeType: 'application/json',
    }));

    if (isClaudeDesktopClient) {
      this.logger.debug('Claude Desktop detected: removing ResourceLinks from response');
    }

    // NOTE: ResourceLinks in content array are spec-compliant (MCP 2025-06-18)
    // but Claude Desktop (as of 2025-10-10) doesn't handle mixed content types properly.
    // This is a Claude Desktop bug, not a server issue.
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: isClaudeDesktopClient
          ? [{ type: 'text', text: `Found ${rows.length} memories:\n${lines}` }]
          : [{ type: 'text', text: `Found ${rows.length} memories:\n${lines}` }, ...resourceLinks],
        structuredContent: { items },
      },
    };
  }

  async handleMemoryList(id, params) {
    try {
      const v = this.validator.validateMemoryList(params);
      const rows = await this.db.listMemories(v.type, v.tags);

      if (!rows.length) {
        return this.createSuccessResponse(id, 'No memories found.', []);
      }

      const items = rows.map(r => ({
        id: r.id,
        type: r.type,
        tags: r.tags ?? [],
        createdAt: r.created_at,
      }));

      // TEMPORARY WORKAROUND: Claude Desktop doesn't support mixed content types
      // and cannot access structuredContent, so we need to include UUIDs in text
      // Remove ResourceLinks when Claude Desktop is detected
      // TODO: Remove when https://github.com/modelcontextprotocol/docs/issues/XXX is fixed
      const isClaudeDesktopClient = this.isClaudeDesktop();

      const lines = rows
        .map(r => {
          const baseLine = `• [${r.type}] tags=${(r.tags ?? []).join(', ')}`;
          if (isClaudeDesktopClient) {
            return `• ID: ${r.id}\n  ${baseLine.substring(2)}`; // Two-line format for readability
          }
          return baseLine;
        })
        .join('\n');

      const resourceLinks = rows.map(r => ({
        type: 'resource_link',
        uri: `mem://item/${r.id}`,
        name: `memory:${r.id}`,
        description: `Full content for ${r.id}`,
        mimeType: 'application/json',
      }));

      if (isClaudeDesktopClient) {
        this.logger.debug('Claude Desktop detected: removing ResourceLinks from response');
      }

      // NOTE: ResourceLinks in content array are spec-compliant (MCP 2025-06-18)
      // but Claude Desktop (as of 2025-10-10) doesn't handle mixed content types properly.
      // This is a Claude Desktop bug, not a server issue.
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: isClaudeDesktopClient
            ? [{ type: 'text', text: `Found ${rows.length} memories:\n${lines}` }]
            : [
                { type: 'text', text: `Found ${rows.length} memories:\n${lines}` },
                ...resourceLinks,
              ],
          structuredContent: { items },
        },
      };
    } catch (error) {
      this.logger.error('List failed', { error: error.message });
      return this.createErrorResponse(id, -32000, `List failed: ${error.message}`);
    }
  }

  async handleMemoryGet(id, params) {
    try {
      const validated = this.validator.validateMemoryGet(params);
      const memory = await this.db.getMemoryById(validated.id);

      if (!memory) {
        this.logger.warn('Memory not found', { id: validated.id });
        return this.createErrorResponse(id, -32000, `Memory not found: ${validated.id}`);
      }

      this.logger.info('Memory retrieved', {
        id: memory.id,
        type: memory.type,
        tagsCount: Array.isArray(memory.tags) ? memory.tags.length : 0,
      });

      const textContent = [
        `Memory: ${memory.id}`,
        `Type: ${memory.type}`,
        `Source: ${memory.source}`,
        `Tags: ${JSON.stringify(memory.tags ?? [])}`,
        `Confidence: ${memory.confidence}`,
        `Created: ${memory.created_at}`,
        `Updated: ${memory.updated_at}`,
        '',
        'Content:',
        JSON.stringify(memory.content, null, 2),
      ].join('\n');

      return this.createSuccessResponse(id, textContent, {
        id: memory.id,
        type: memory.type,
        content: memory.content,
        source: memory.source,
        tags: memory.tags ?? [],
        confidence: memory.confidence,
        createdAt: memory.created_at,
        updatedAt: memory.updated_at,
      });
    } catch (error) {
      this.logger.error('Failed to get memory', {
        error: error.message,
        id: params?.id,
      });
      return this.createErrorResponse(id, -32000, `Failed to get memory: ${error.message}`);
    }
  }

  async handleToolCall(id, params) {
    const toolName = params.name;
    const toolArgs = params.arguments || params.input || {};

    // Normalize tool name
    const normalized = String(toolName || '')
      .split('/')
      .pop()
      .replaceAll('.', '_');

    this.logger.debug('Tool call', { toolName, normalized, toolArgs });

    switch (normalized) {
      case 'memory_create':
        return await this.handleMemoryCreate(id, toolArgs);
      case 'memory_search':
        return await this.handleMemorySearch(id, toolArgs);
      case 'memory_list':
        return await this.handleMemoryList(id, toolArgs);
      case 'memory_get':
        return await this.handleMemoryGet(id, toolArgs);
      default:
        this.logger.warn('Unknown tool', { tool: toolName });
        return this.createErrorResponse(id, -32601, `Tool not found: ${toolName}`);
    }
  }

  handleListPrompts(id) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        prompts: [
          {
            name: 'memory_recall',
            description: 'Search memory and insert a digest.',
            inputSchema: {
              type: 'object',
              required: ['query'],
              properties: {
                query: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                limit: { oneOf: [{ type: 'number' }, { type: 'string' }] },
              },
            },
          },
          {
            name: 'memory_save',
            description: 'Summarize current changes and save to memory_create.',
            inputSchema: {
              type: 'object',
              required: ['type', 'source', 'confidence'],
              properties: {
                type: { type: 'string' },
                source: { type: 'string' },
                confidence: { oneOf: [{ type: 'number' }, { type: 'string' }] },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        ],
      },
    };
  }
}
