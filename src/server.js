'use strict';

import crypto from 'crypto';
import pg from 'pg';
import { pipeline } from '@xenova/transformers';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import dotenv from 'dotenv';
import { createRequire } from 'module';
import { URL } from 'url';

const require = createRequire(import.meta.url);
const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.join(__dirname, '../.env'),
  quiet: true,
});

// ============================================================================
// CONFIGURATION
// ============================================================================

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

class Config {
  constructor() {
    this.validateRequiredEnvVars();
    this.initializeServer();
    this.initializeLogging();
    this.initializeDb();
    this.initializeEmbeddings();
    this.initializeSearch();
    this.initializeSecurity();
  }

  initializeServer() {
    this.server = {
      name: process.env.MCP_SERVER_NAME || 'memory',
      version: process.env.MCP_SERVER_VERSION || '1.0.0',
      displayName: process.env.MCP_SERVER_DISPLAY_NAME || 'Memory Server',
      description:
        process.env.MCP_SERVER_DESCRIPTION ||
        'A server for storing and retrieving memories with semantic search capabilities',
      publisher: process.env.MCP_SERVER_PUBLISHER || 'MCP',
      protocolVersion: process.env.MCP_PROTOCOL_VERSION || '2024-11-05',
    };
  }

  initializeLogging() {
    this.logging = {
      levels: ['error', 'warn', 'info', 'debug'],
      debugFile: process.env.MCP_DEBUG_LOG_PATH || path.join(__dirname, '../memory-debug.log'),
      level: process.env.LOG_LEVEL || 'info',
    };
  }

  initializeDb() {
    this.db = {
      connectionString: process.env.DATABASE_URL,
      maxPoolSize: this.parseIntWithDefault({
        value: process.env.DB_MAX_POOL_SIZE,
        defaultValue: 20,
        min: 1,
        max: 100,
      }),
      idleTimeout: this.parseIntWithDefault({
        value: process.env.DB_IDLE_TIMEOUT,
        defaultValue: 30000,
        min: 1000,
        max: 300000,
      }),
      queryTimeout: this.parseIntWithDefault({
        value: process.env.DB_QUERY_TIMEOUT,
        defaultValue: 30000,
        min: 1000,
        max: 300000,
      }),
    };
  }

  initializeEmbeddings() {
    this.embeddings = {
      model: process.env.EMBEDDINGS_MODEL || 'Xenova/all-MiniLM-L6-v2',
      pooling: process.env.EMBEDDINGS_POOLING || 'mean',
      normalize: process.env.EMBEDDINGS_NORMALIZE !== 'false',
      maxRetries: this.parseIntWithDefault({
        value: process.env.EMBEDDINGS_MAX_RETRIES,
        defaultValue: 3,
        min: 1,
        max: 10,
      }),
    };
  }

  initializeSearch() {
    this.search = {
      defaultLimit: this.parseIntWithDefault({
        value: process.env.SEARCH_DEFAULT_LIMIT,
        defaultValue: 10,
        min: 1,
        max: 100,
      }),
      maxLimit: this.parseIntWithDefault({
        value: process.env.SEARCH_MAX_LIMIT,
        defaultValue: 100,
        min: 1,
        max: 1000,
      }),
    };
  }

  initializeSecurity() {
    this.security = {
      maxContentLength: this.parseIntWithDefault({
        value: process.env.MAX_CONTENT_LENGTH,
        defaultValue: 10000,
        min: 1,
        max: 100000,
      }),
      maxTagsCount: this.parseIntWithDefault({
        value: process.env.MAX_TAGS_COUNT,
        defaultValue: 20,
        min: 1,
        max: 100,
      }),
    };
  }

  parseIntWithDefault(config) {
    const { value, defaultValue, min, max } = config;
    if (!value) {
      return defaultValue;
    }
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      return defaultValue;
    }
    return Math.max(min, Math.min(max, parsed));
  }

  validateRequiredEnvVars() {
    if (!process.env.DATABASE_URL) {
      throw new ConfigurationError('DATABASE_URL environment variable is required');
    }
  }
}

// ============================================================================
// LOGGING SYSTEM
// ============================================================================

class Logger {
  constructor(config) {
    this.config = config;
    this.levels = { error: 0, warn: 1, info: 2, debug: 3 };
    this.currentLevel = this.levels[config.logging.level] || this.levels.info;
    this.initLogFile();
  }

  initLogFile() {
    try {
      const timestamp = new Date().toISOString();
      const dir = path.dirname(this.config.logging.debugFile);
      require('fs').mkdirSync(dir, { recursive: true });
      const content = `[${timestamp}] Memory server starting - Log level: ${this.config.logging.level}\n`;
      require('fs').writeFileSync(this.config.logging.debugFile, content);
    } catch (error) {
      // Logger might not be available yet, use stderr
      process.stderr.write(`Failed to initialize debug log: ${error.message}\n`);
    }
  }

  shouldLog(level) {
    return this.levels[level] <= this.currentLevel;
  }

  log(level, message, data = {}) {
    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = new Date().toISOString();

    // Write to file
    try {
      const logLine = `[${timestamp}] ${level.toUpperCase()} ${message} ${Object.keys(data).length > 0 ? JSON.stringify(data) : ''}\n`;
      require('fs').appendFileSync(this.config.logging.debugFile, logLine);
    } catch (error) {
      // Use stderr as fallback since logger might not be available
      process.stderr.write(`Failed to write to debug log: ${error.message}\n`);
    }

    // Send MCP log message
    this.sendMCPLogMessage(level, message, data);
  }

  sendMCPLogMessage(level, message, context = {}) {
    const logMessage = {
      jsonrpc: '2.0',
      method: 'log',
      params: {
        level,
        message,
        timestamp: new Date().toISOString(),
        context,
      },
    };

    try {
      process.stderr.write(JSON.stringify(logMessage) + '\n');
    } catch (error) {
      // Use stderr as fallback since logger might not be available
      process.stderr.write(`Error sending MCP log message: ${error.message}\n`);
    }
  }

  error(message, data = {}) {
    this.log('error', message, data);
  }
  warn(message, data = {}) {
    this.log('warn', message, data);
  }
  info(message, data = {}) {
    this.log('info', message, data);
  }
  debug(message, data = {}) {
    this.log('debug', message, data);
  }
}

// ============================================================================
// INPUT VALIDATION
// ============================================================================

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

class Validator {
  constructor(config) {
    this.config = config;
    this.TAG_RE = /^[a-z0-9:_-]{1,100}$/;
  }

  validateMemoryCreate(params) {
    this.validateType(params.type);
    this.validateContent(params.content);
    this.validateSource(params.source);
    this.validateConfidence(params.confidence);
    this.validateTags(params.tags);
    this.validateContentLength(params.content);

    const sanitizedTags = this.sanitizeTags(params.tags);
    const sanitized = {
      type: params.type.trim().slice(0, 50),
      content: params.content,
      source: params.source.trim().slice(0, 100),
      tags: sanitizedTags,
      confidence: params.confidence,
    };

    return sanitized;
  }

  validateType(type) {
    if (!type || typeof type !== 'string' || type.trim().length === 0) {
      throw new ValidationError('type is required and must be a non-empty string');
    }
  }

  validateContent(content) {
    if (!content) {
      throw new ValidationError('content is required');
    }
  }

  validateSource(source) {
    if (!source || typeof source !== 'string' || source.trim().length === 0) {
      throw new ValidationError('source is required and must be a non-empty string');
    }
  }

  validateConfidence(confidence) {
    if (
      confidence === undefined ||
      typeof confidence !== 'number' ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new ValidationError('confidence is required and must be a number between 0 and 1');
    }
  }

  validateTags(tags = []) {
    if (!Array.isArray(tags)) {
      throw new ValidationError('tags must be an array');
    }

    if (tags.length > this.config.security.maxTagsCount) {
      throw new ValidationError(
        `tags array cannot have more than ${this.config.security.maxTagsCount} items`
      );
    }
  }

  validateContentLength(content) {
    const contentStr = JSON.stringify(content);
    if (contentStr.length > this.config.security.maxContentLength) {
      throw new ValidationError(
        `content is too large (max ${this.config.security.maxContentLength} characters)`
      );
    }
  }

  sanitizeTags(tags) {
    return Array.from(
      new Set(
        tags.map(tag => {
          const t = String(tag).trim().toLowerCase();
          if (!this.TAG_RE.test(t)) {
            throw new ValidationError(`invalid tag: "${tag}"`);
          }
          return t;
        })
      )
    );
  }

  validateMemorySearch(params) {
    const { query, type, tags, limit } = params;

    this.validateQuery(query);
    const searchLimit = this.validateAndParseLimit(limit);
    const validated = {
      query: query.trim(),
      limit: searchLimit,
    };

    if (type) {
      this.validateType(type);
      validated.type = type.trim().slice(0, 50);
    }

    if (tags) {
      validated.tags = this.validateSearchTags(tags);
    }

    return validated;
  }

  validateQuery(query) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new ValidationError('query is required and must be a non-empty string');
    }

    if (query.length > 1000) {
      throw new ValidationError('query length cannot exceed 1000 characters');
    }
  }

  validateAndParseLimit(limit) {
    let searchLimit = this.config.search.defaultLimit;
    if (limit !== undefined) {
      if (typeof limit !== 'number' || limit < 1) {
        throw new ValidationError('limit must be a positive number');
      }
      searchLimit = Math.min(limit, this.config.search.maxLimit);
    }
    return searchLimit;
  }

  validateSearchTags(tags) {
    if (!Array.isArray(tags)) {
      throw new ValidationError('tags must be an array');
    }
    return tags.map(tag => {
      const t = String(tag).trim().toLowerCase();
      if (!this.TAG_RE.test(t)) {
        throw new ValidationError(`invalid tag: "${tag}"`);
      }
      return t;
    });
  }

  validateMemoryList(params = {}) {
    const { type, tags } = params;
    const validated = {};

    if (type) {
      if (typeof type !== 'string' || type.trim().length === 0) {
        throw new ValidationError('type must be a non-empty string');
      }
      validated.type = type.trim().slice(0, 50);
    }

    if (tags) {
      if (!Array.isArray(tags)) {
        throw new ValidationError('tags must be an array');
      }
      validated.tags = tags.map(tag => {
        const t = String(tag).trim().toLowerCase();
        if (!this.TAG_RE.test(t)) {
          throw new ValidationError(`invalid tag: "${tag}"`);
        }
        return t;
      });
    }

    return validated;
  }

  validateMemoryGet(params) {
    const { id } = params;

    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new ValidationError('id is required and must be a non-empty string');
    }

    // Basic UUID format validation (optional but recommended)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const trimmedId = id.trim();

    if (!uuidRegex.test(trimmedId)) {
      throw new ValidationError('id must be a valid UUID format');
    }

    return { id: trimmedId };
  }
}

// ============================================================================
// DATABASE MANAGER
// ============================================================================

class DatabaseError extends Error {
  constructor(message, originalError) {
    super(message);
    this.name = 'DatabaseError';
    this.originalError = originalError;
  }
}

class DatabaseManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.pool = null;
    this.isInitialized = false;
  }

  async initialize() {
    try {
      this.pool = new Pool({
        connectionString: this.config.db.connectionString,
        max: this.config.db.maxPoolSize,
        idleTimeoutMillis: this.config.db.idleTimeout,
        query_timeout: this.config.db.queryTimeout,
        statement_timeout: this.config.db.queryTimeout,
        application_name: 'mcp-memory',
      });

      // Test connection
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();

      await this.initializeSchema();
      this.isInitialized = true;
      this.logger.info('Database initialized successfully');
      if (!this.config.embeddings.normalize) {
        this.logger.warn(
          'Embeddings normalization is OFF. Cosine similarity (1 - cosine distance) may be less stable.'
        );
      }
    } catch (error) {
      this.logger.error('Failed to initialize database', { error: error.message });
      throw new DatabaseError('Database initialization failed', error);
    }
  }

  initializeSchema() {
    // Schema initialization is handled by Docker's init SQL (docker/db/00-init.sql)
    this.logger.info('Skipping code-based schema migration (handled by Docker init)');
  }

  async ensureInitialized() {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  async createMemory(memoryData) {
    const { type, content, source, embedding, tags, confidence } = memoryData;
    await this.ensureInitialized();

    try {
      const query = `
        INSERT INTO memories (type, content, source, embedding, tags, confidence)
        VALUES ($1, $2::jsonb, $3, $4::vector, $5, $6)
        RETURNING id, type, content, source, tags, confidence, created_at, updated_at
      `;

      const result = await this.pool.query(query, [
        type,
        JSON.stringify(content),
        source,
        `[${embedding.join(',')}]`,
        tags,
        confidence,
      ]);

      return result.rows[0];
    } catch (error) {
      this.logger.error('Failed to create memory', { error: error.message });
      throw new DatabaseError('Failed to create memory', error);
    }
  }

  async searchMemories(searchParams) {
    const { embedding, type, tags, limit } = searchParams;
    await this.ensureInitialized();

    try {
      const { sqlQuery, queryParams } = this.buildSearchQuery({ embedding, type, tags, limit });
      const result = await this.pool.query(sqlQuery, queryParams);
      return result.rows;
    } catch (error) {
      this.logger.error('Failed to search memories', { error: error.message });
      throw new DatabaseError('Failed to search memories', error);
    }
  }

  buildSearchQuery(params) {
    const { embedding, type, tags, limit } = params;
    let sqlQuery = `
      SELECT id, type, tags, confidence, created_at, updated_at,
            1 - (embedding <#> $1::vector) as similarity
      FROM memories
      WHERE 1=1
    `;

    const queryParams = [`[${embedding.join(',')}]`];
    let paramCount = 1;

    if (type) {
      paramCount++;
      sqlQuery += ` AND type = $${paramCount}`;
      queryParams.push(type);
    }

    if (tags && tags.length > 0) {
      paramCount++;
      sqlQuery += ` AND tags && $${paramCount}::text[]`;
      queryParams.push(tags);
    }

    paramCount++;
    sqlQuery += ` ORDER BY similarity DESC LIMIT $${paramCount}`;
    queryParams.push(limit);

    return { sqlQuery, queryParams };
  }

  async listMemories(type, tags) {
    await this.ensureInitialized();

    try {
      let sqlQuery = `
        SELECT id, type, tags, confidence, created_at, updated_at
        FROM memories
        WHERE 1=1
      `;

      const queryParams = [];
      let paramCount = 0;

      if (type) {
        paramCount++;
        sqlQuery += ` AND type = $${paramCount}`;
        queryParams.push(type);
      }

      if (tags && tags.length > 0) {
        paramCount++;
        sqlQuery += ` AND tags && $${paramCount}::text[]`;
        queryParams.push(tags);
      }

      sqlQuery += ' ORDER BY created_at DESC';

      const result = await this.pool.query(sqlQuery, queryParams);
      return result.rows;
    } catch (error) {
      this.logger.error('Failed to list memories', { error: error.message });
      throw new DatabaseError('Failed to list memories', error);
    }
  }

  async upsertMemory(memoryData) {
    const { type, content, source, embedding, tags, confidence, contentHash } = memoryData;
    await this.ensureInitialized();
    const sql = `
      INSERT INTO memories (type, content, source, embedding, tags, confidence, content_hash)
      VALUES ($1, $2::jsonb, $3, $4::vector, $5, $6, $7)
      ON CONFLICT (content_hash) DO UPDATE
        SET tags = (SELECT ARRAY(SELECT DISTINCT UNNEST(memories.tags || EXCLUDED.tags))),
            confidence = GREATEST(memories.confidence, EXCLUDED.confidence),
            updated_at = NOW()
      RETURNING id, type, content, source, tags, confidence, created_at, updated_at
    `;
    const params = [
      type,
      JSON.stringify(content),
      source,
      `[${embedding.join(',')}]`,
      tags,
      confidence,
      contentHash,
    ];
    const res = await this.pool.query(sql, params);
    return res.rows[0];
  }

  async getMemoryById(id) {
    await this.ensureInitialized();
    const res = await this.pool.query(
      `SELECT id, type, content, source, tags, confidence, created_at, updated_at
        FROM memories WHERE id = $1`,
      [id]
    );
    return res.rows[0] ?? null;
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.isInitialized = false;
      this.logger.info('Database connection closed');
    }
  }
}

// ============================================================================
// EMBEDDINGS MANAGER
// ============================================================================

class EmbeddingsError extends Error {
  constructor(message, originalError) {
    super(message);
    this.name = 'EmbeddingsError';
    this.originalError = originalError;
  }
}

class EmbeddingsManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.embedder = null;
    this.isInitializing = false;

    this.cache = new Map();
    this.maxCache = parseInt(process.env.EMBEDDINGS_CACHE_SIZE ?? '500', 10);
  }

  cacheKey(text) {
    return (
      crypto.createHash('sha256').update(text).digest('hex') + '::' + this.config.embeddings.model
    );
  }

  getFromCache(key) {
    const hit = this.cache.get(key);
    if (!hit) {
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, hit); // LRU bump
    return hit;
  }

  putToCache(key, vec) {
    this.cache.set(key, vec);
    if (this.cache.size > this.maxCache) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  prepareContentForEmbedding(content) {
    if (typeof content === 'string') {
      return content;
    }
    return JSON.stringify(content);
  }

  async initializeEmbedder() {
    if (this.embedder) {
      return this.embedder;
    }

    if (this.isInitializing) {
      this.logger.info('Waiting for embedder initialization...');
      while (!this.embedder && this.isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return this.embedder;
    }

    this.isInitializing = true;

    try {
      this.logger.info('Initializing embedder...', { model: this.config.embeddings.model });
      this.embedder = await pipeline('feature-extraction', this.config.embeddings.model);
      this.logger.info('Embedder initialized successfully');
      return this.embedder;
    } catch (error) {
      this.logger.error('Failed to initialize embedder', { error: error.message });
      this.isInitializing = false;
      throw new EmbeddingsError('Failed to initialize embedder', error);
    } finally {
      this.isInitializing = false;
    }
  }

  async generateEmbedding(text, retryCount = 0) {
    const key = this.cacheKey(text);
    const cached = this.getFromCache(key);
    if (cached) {
      this.logger.debug('Embedding cache hit', { textLength: text.length });
      return cached;
    }
    try {
      const model = await this.initializeEmbedder();
      const output = await model(text, {
        pooling: this.config.embeddings.pooling,
        normalize: this.config.embeddings.normalize,
      });

      const vec = Array.from(output.data);
      this.putToCache(key, vec);
      this.logger.debug('Generated embedding', { textLength: text.length });
      return vec;
    } catch (error) {
      this.logger.error('Failed to generate embedding', {
        error: error.message,
        retryCount,
        textLength: text.length,
      });

      if (retryCount < this.config.embeddings.maxRetries) {
        this.logger.info(
          `Retrying embedding generation (${retryCount + 1}/${this.config.embeddings.maxRetries})`
        );
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        return this.generateEmbedding(text, retryCount + 1);
      }

      throw new EmbeddingsError('Failed to generate embedding after retries', error);
    }
  }
}

// ============================================================================
// MCP PROTOCOL HANDLER
// ============================================================================

class MCPProtocolHandler {
  // Deterministic deep stringify (стабилен к порядку ключей на любой глубине)
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
            confidence: { type: 'number', description: 'Confidence score between 0 and 1' },
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
            limit: { type: 'number', description: 'Maximum number of results to return' },
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

    const lines = rows
      .map(
        r => `• [${r.type}] sim=${(r.similarity ?? 0).toFixed(3)} tags=${(r.tags ?? []).join(', ')}`
      )
      .join('\n');

    // TEMPORARY WORKAROUND: Claude Desktop doesn't support mixed content types
    // Remove ResourceLinks when Claude Desktop is detected
    // TODO: Remove when https://github.com/modelcontextprotocol/docs/issues/XXX is fixed
    const isClaudeDesktopClient = this.isClaudeDesktop();

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

      const lines = rows.map(r => `• [${r.type}] tags=${(r.tags ?? []).join(', ')}`).join('\n');

      // TEMPORARY WORKAROUND: Claude Desktop doesn't support mixed content types
      // Remove ResourceLinks when Claude Desktop is detected
      // TODO: Remove when https://github.com/modelcontextprotocol/docs/issues/XXX is fixed
      const isClaudeDesktopClient = this.isClaudeDesktop();

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
                limit: { type: 'number' },
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
                confidence: { type: 'number' },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        ],
      },
    };
  }
}

// ============================================================================
// MAIN SERVER CLASS
// ============================================================================

class MemoryServer {
  constructor() {
    this.config = null;
    this.logger = null;
    this.db = null;
    this.embeddings = null;
    this.validator = null;
    this.mcpHandler = null;
    this.rl = null;
  }

  initialize() {
    try {
      this.config = new Config();
      this.logger = new Logger(this.config);
      this.initializeComponents();
      this.setupStdio();
      this.setupGracefulShutdown();

      this.logger.info('Memory server started successfully', {
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
      });
    } catch (error) {
      process.stderr.write(`Failed to initialize server: ${error.message}\n`);
      process.exit(1);
    }
  }

  initializeComponents() {
    this.db = new DatabaseManager(this.config, this.logger);
    this.embeddings = new EmbeddingsManager(this.config, this.logger);
    this.validator = new Validator(this.config);
    this.mcpHandler = new MCPProtocolHandler({
      config: this.config,
      logger: this.logger,
      databaseManager: this.db,
      embeddingsManager: this.embeddings,
      validator: this.validator,
    });
  }

  setupStdio() {
    this.rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    process.stdin.setEncoding('utf8');
    process.stdout.setDefaultEncoding('utf8');

    this.rl.on('line', this.handleMessage.bind(this));
    this.rl.on('close', () => {
      this.logger.info('readline interface closed');
    });

    process.stdin.on('error', error => {
      this.logger.error('stdin error', { error: error.message });
    });

    process.stdout.on('error', error => {
      this.logger.error('stdout error', { error: error.message });
    });
  }

  async handleMessage(line) {
    try {
      this.logger.debug('Received message', { length: line.length });

      const message = this.parseMessage(line);
      if (!message) {
        return;
      }

      const response = await this.processMessage(message);
      if (response) {
        this.sendResponse(response);
      }
    } catch (error) {
      this.logger.error('Error handling message', { error: error.message, stack: error.stack });
    }
  }

  parseMessage(line) {
    try {
      return JSON.parse(line);
    } catch (error) {
      this.logger.error('Failed to parse JSON', {
        error: error.message,
        line: line.slice(0, 100),
      });
      return null;
    }
  }

  processMessage(message) {
    const { jsonrpc, id, method, params = {} } = message;

    // Handle notifications (no response needed)
    if (id === undefined || id === null) {
      this.handleNotification(method);
      return null;
    }

    // Validate JSON-RPC version
    if (jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32600,
          message: 'Invalid Request: jsonrpc version must be 2.0',
        },
      };
    }

    return this.handleMethod(method, id, params);
  }

  handleNotification(method) {
    if (method === 'initialized' || method === 'notifications/initialized') {
      this.logger.info('Received initialized notification');
    } else {
      this.logger.info(`Received notification: ${method}`);
    }
  }

  handleMethod(method, id, params) {
    if (this.isInitializeMethod(method)) {
      return this.mcpHandler.handleInitialize(id, params);
    }

    if (this.isToolsListMethod(method)) {
      return this.mcpHandler.handleListTools(id);
    }

    if (this.isToolsCallMethod(method)) {
      return this.handleToolCall(id, params);
    }

    if (this.isResourcesListMethod(method)) {
      return this.mcpHandler.handleListResources(id);
    }

    if (this.isResourcesTemplatesMethod(method)) {
      return this.mcpHandler.handleListResourceTemplates(id);
    }

    if (this.isResourcesReadMethod(method)) {
      return this.mcpHandler.handleReadResource(id, params);
    }

    if (this.isPromptsListMethod(method)) {
      return this.mcpHandler.handleListPrompts(id);
    }

    return this.handleUnknownMethod(method, id);
  }

  isInitializeMethod(method) {
    return method === 'initialize';
  }

  isToolsListMethod(method) {
    return method === 'tools/list' || method === 'listTools';
  }

  isToolsCallMethod(method) {
    return method === 'tools/call' || method === 'callTool';
  }

  isResourcesListMethod(method) {
    return method === 'resources/list' || method === 'listResources';
  }

  isResourcesTemplatesMethod(method) {
    return method === 'resources/templates/list';
  }

  isResourcesReadMethod(method) {
    return method === 'resources/read';
  }

  isPromptsListMethod(method) {
    return method === 'prompts/list' || method === 'listPrompts';
  }

  handleUnknownMethod(method, id) {
    this.logger.warn('Unknown method', { method });
    return this.mcpHandler.createErrorResponse(id, -32601, `Method not found: ${method}`);
  }

  handleToolCall(id, params) {
    if (!this.mcpHandler.isInitialized) {
      return this.mcpHandler.createErrorResponse(id, -32002, 'Server not initialized');
    }
    return this.mcpHandler.handleToolCall(id, params);
  }

  sendResponse(response) {
    try {
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (error) {
      this.logger.error('Failed to send response', { error: error.message });
    }
  }

  setupGracefulShutdown() {
    const shutdown = async signal => {
      this.logger.info(`Received ${signal}, shutting down gracefully...`);

      if (this.rl) {
        this.rl.close();
      }
      if (this.db) {
        await this.db.close();
      }

      this.logger.info('Shutdown completed');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

// ============================================================================
// STARTUP
// ============================================================================

const server = new MemoryServer();
server.initialize();
