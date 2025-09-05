import pg from 'pg';
import { pipeline } from '@xenova/transformers';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import dotenv from 'dotenv';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

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
    
    this.server = {
      name: process.env.MCP_SERVER_NAME || "memory",
      version: process.env.MCP_SERVER_VERSION || "1.0.0",
      displayName: process.env.MCP_SERVER_DISPLAY_NAME || "Memory Server",
      description: process.env.MCP_SERVER_DESCRIPTION || "A server for storing and retrieving memories with semantic search capabilities",
      publisher: process.env.MCP_SERVER_PUBLISHER || "MCP",
      protocolVersion: process.env.MCP_PROTOCOL_VERSION || "2024-11-05"
    };
    
    this.logging = {
      levels: ["error", "warn", "info", "debug"],
      debugFile: process.env.MCP_DEBUG_LOG_PATH || path.join(__dirname, '../memory-debug.log'),
      level: process.env.LOG_LEVEL || "info"
    };
    
    this.db = {
      connectionString: process.env.DATABASE_URL,
      maxPoolSize: this.parseIntWithDefault(process.env.DB_MAX_POOL_SIZE, 20, 1, 100),
      idleTimeout: this.parseIntWithDefault(process.env.DB_IDLE_TIMEOUT, 30000, 1000, 300000),
      queryTimeout: this.parseIntWithDefault(process.env.DB_QUERY_TIMEOUT, 30000, 1000, 300000)
    };
    
    this.embeddings = {
      model: process.env.EMBEDDINGS_MODEL || "Xenova/all-MiniLM-L6-v2",
      pooling: process.env.EMBEDDINGS_POOLING || "mean",
      normalize: process.env.EMBEDDINGS_NORMALIZE !== "false",
      maxRetries: this.parseIntWithDefault(process.env.EMBEDDINGS_MAX_RETRIES, 3, 1, 10)
    };
    
    this.search = {
      defaultLimit: this.parseIntWithDefault(process.env.SEARCH_DEFAULT_LIMIT, 10, 1, 100),
      maxLimit: this.parseIntWithDefault(process.env.SEARCH_MAX_LIMIT, 100, 1, 1000)
    };

    this.security = {
      maxContentLength: this.parseIntWithDefault(process.env.MAX_CONTENT_LENGTH, 10000, 1, 100000),
      maxTagsCount: this.parseIntWithDefault(process.env.MAX_TAGS_COUNT, 20, 1, 100)
    };
  }

  validateRequiredEnvVars() {
    if (!process.env.DATABASE_URL) {
      throw new ConfigurationError('DATABASE_URL environment variable is required');
    }
  }

  parseIntWithDefault(value, defaultValue, min, max) {
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) return defaultValue;
    return Math.max(min, Math.min(max, parsed));
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
      const content = `[${timestamp}] Memory server starting - Log level: ${this.config.logging.level}\n`;
      require('fs').writeFileSync(this.config.logging.debugFile, content);
    } catch (error) {
      console.error(`Failed to initialize debug log: ${error.message}`);
    }
  }

  shouldLog(level) {
    return this.levels[level] <= this.currentLevel;
  }

  log(level, message, data = {}) {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...data
    };

    // Write to file
    try {
      const logLine = `[${timestamp}] ${level.toUpperCase()} ${message} ${Object.keys(data).length > 0 ? JSON.stringify(data) : ''}\n`;
      require('fs').appendFileSync(this.config.logging.debugFile, logLine);
    } catch (error) {
      console.error(`Failed to write to debug log: ${error.message}`);
    }

    // Send MCP log message
    this.sendMCPLogMessage(level, message, data);
  }

  sendMCPLogMessage(level, message, context = {}) {
    const logMessage = {
      jsonrpc: "2.0",
      method: "log",
      params: {
        level,
        message,
        timestamp: new Date().toISOString(),
        context
      }
    };
    
    try {
      process.stderr.write(JSON.stringify(logMessage) + '\n');
    } catch (error) {
      console.error(`Error sending MCP log message: ${error.message}`);
    }
  }

  error(message, data = {}) { this.log('error', message, data); }
  warn(message, data = {}) { this.log('warn', message, data); }
  info(message, data = {}) { this.log('info', message, data); }
  debug(message, data = {}) { this.log('debug', message, data); }
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
  }

  validateMemoryCreate(params) {
    const { type, content, source, tags = [], confidence } = params;
    
    if (!type || typeof type !== 'string' || type.trim().length === 0) {
      throw new ValidationError('type is required and must be a non-empty string');
    }
    
    if (!content) {
      throw new ValidationError('content is required');
    }
    
    if (!source || typeof source !== 'string' || source.trim().length === 0) {
      throw new ValidationError('source is required and must be a non-empty string');
    }
    
    if (confidence === undefined || typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      throw new ValidationError('confidence is required and must be a number between 0 and 1');
    }
    
    if (!Array.isArray(tags)) {
      throw new ValidationError('tags must be an array');
    }
    
    if (tags.length > this.config.security.maxTagsCount) {
      throw new ValidationError(`tags array cannot have more than ${this.config.security.maxTagsCount} items`);
    }
    
    // Validate content length
    const contentStr = JSON.stringify(content);
    if (contentStr.length > this.config.security.maxContentLength) {
      throw new ValidationError(`content is too large (max ${this.config.security.maxContentLength} characters)`);
    }
    
    // Validate tags
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag.trim().length === 0) {
        throw new ValidationError('all tags must be non-empty strings');
      }
      if (tag.length > 100) {
        throw new ValidationError('tag length cannot exceed 100 characters');
      }
    }
    
    // Sanitize type and source
    const sanitized = {
      type: type.trim().slice(0, 50),
      content,
      source: source.trim().slice(0, 100),
      tags: tags.map(tag => tag.trim().slice(0, 100)),
      confidence
    };
    
    return sanitized;
  }

  validateMemorySearch(params) {
    const { query, type, tags, limit } = params;
    
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new ValidationError('query is required and must be a non-empty string');
    }
    
    if (query.length > 1000) {
      throw new ValidationError('query length cannot exceed 1000 characters');
    }
    
    let searchLimit = this.config.search.defaultLimit;
    if (limit !== undefined) {
      if (typeof limit !== 'number' || limit < 1) {
        throw new ValidationError('limit must be a positive number');
      }
      searchLimit = Math.min(limit, this.config.search.maxLimit);
    }
    
    const validated = {
      query: query.trim(),
      limit: searchLimit
    };
    
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
      validated.tags = tags.filter(tag => 
        typeof tag === 'string' && tag.trim().length > 0
      ).map(tag => tag.trim().slice(0, 100));
    }
    
    return validated;
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
      validated.tags = tags.filter(tag => 
        typeof tag === 'string' && tag.trim().length > 0
      ).map(tag => tag.trim().slice(0, 100));
    }
    
    return validated;
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
        statement_timeout: this.config.db.queryTimeout
      });

      // Test connection
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      await this.initializeSchema();
      this.isInitialized = true;
      this.logger.info('Database initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize database', { error: error.message });
      throw new DatabaseError('Database initialization failed', error);
    }
  }

  async initializeSchema() {
    // Schema initialization is handled by Docker's init SQL (docker/db/00-init.sql)
    this.logger.info('Skipping code-based schema migration (handled by Docker init)');
  }

  async ensureInitialized() {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  async createMemory(type, content, source, embedding, tags, confidence) {
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
        confidence
      ]);
      
      return result.rows[0];
    } catch (error) {
      this.logger.error('Failed to create memory', { error: error.message });
      throw new DatabaseError('Failed to create memory', error);
    }
  }

  async searchMemories(embedding, type, tags, limit) {
    await this.ensureInitialized();
    
    try {
      let sqlQuery = `
        SELECT id, type, content, source, tags, confidence, created_at, updated_at,
               1 - (embedding <=> $1::vector) as similarity
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
        sqlQuery += ` AND tags && $${paramCount}`;
        queryParams.push(tags);
      }
      
      paramCount++;
      sqlQuery += ` ORDER BY similarity DESC LIMIT $${paramCount}`;
      queryParams.push(limit);
      
      const result = await this.pool.query(sqlQuery, queryParams);
      return result.rows;
    } catch (error) {
      this.logger.error('Failed to search memories', { error: error.message });
      throw new DatabaseError('Failed to search memories', error);
    }
  }

  async listMemories(type, tags) {
    await this.ensureInitialized();
    
    try {
      let sqlQuery = `
        SELECT id, type, content, source, tags, confidence, created_at, updated_at
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
        sqlQuery += ` AND tags && $${paramCount}`;
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
  }

  prepareContentForEmbedding(content) {
    if (typeof content === 'string') return content;
    return JSON.stringify(content);
  }

  async initializeEmbedder() {
    if (this.embedder) return this.embedder;
    
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
    try {
      const model = await this.initializeEmbedder();
      const output = await model(text, {
        pooling: this.config.embeddings.pooling,
        normalize: this.config.embeddings.normalize
      });
      
      this.logger.debug('Generated embedding', { textLength: text.length });
      return Array.from(output.data);
    } catch (error) {
      this.logger.error('Failed to generate embedding', { 
        error: error.message, 
        retryCount, 
        textLength: text.length 
      });
      
      if (retryCount < this.config.embeddings.maxRetries) {
        this.logger.info(`Retrying embedding generation (${retryCount + 1}/${this.config.embeddings.maxRetries})`);
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
  constructor(config, logger, databaseManager, embeddingsManager, validator) {
    this.config = config;
    this.logger = logger;
    this.db = databaseManager;
    this.embeddings = embeddingsManager;
    this.validator = validator;
    this.isInitialized = false;
  }

  createErrorResponse(id, code, message) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code, message }
    };
  }

  createSuccessResponse(id, content) {
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: content }] }
    };
  }

  async handleInitialize(id, params) {
    if (this.isInitialized) {
      return this.createErrorResponse(id, -32002, "Server already initialized");
    }

    this.logger.info('Processing initialize request', {
      clientInfo: params.clientInfo,
      clientProtocolVersion: params.protocolVersion
    });

    const response = {
      jsonrpc: "2.0",
      id,
      result: {
        serverInfo: {
          name: this.config.server.name,
          version: this.config.server.version,
          displayName: this.config.server.displayName,
          description: this.config.server.description,
          publisher: this.config.server.publisher
        },
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          prompts: { listChanged: false },
          logging: { levels: this.config.logging.levels }
        },
        protocolVersion: params.protocolVersion || this.config.server.protocolVersion
      }
    };

    this.isInitialized = true;
    this.logger.info('Server initialized successfully');
    return response;
  }

  handleListTools(id) {
    const tools = [
      {
        name: "memory_create",
        description: "Create a new memory entry",
        inputSchema: {
          type: "object",
          required: ["type", "content", "source", "confidence"],
          properties: {
            type: { type: "string", description: "Type of memory" },
            content: { type: "object", description: "Content to store" },
            source: { type: "string", description: "Source of the memory" },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
            confidence: { type: "number", description: "Confidence score between 0 and 1" }
          }
        }
      },
      {
        name: "memory_search",
        description: "Search for memories using semantic similarity",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "Search query" },
            type: { type: "string", description: "Optional type filter" },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags filter" },
            limit: { type: "number", description: "Maximum number of results to return" }
          }
        }
      },
      {
        name: "memory_list",
        description: "List all memories",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Optional type filter" },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags filter" }
          }
        }
      }
    ];

    return {
      jsonrpc: "2.0",
      id,
      result: { tools }
    };
  }

  async handleMemoryCreate(id, params) {
    try {
      const validated = this.validator.validateMemoryCreate(params);
      this.logger.info('Creating new memory', { type: validated.type });

      const textForEmbedding = this.embeddings.prepareContentForEmbedding(validated.content);
      const embedding = await this.embeddings.generateEmbedding(textForEmbedding);

      const memory = await this.db.createMemory(
        validated.type,
        validated.content,
        validated.source,
        embedding,
        validated.tags,
        validated.confidence
      );

      this.logger.info('Memory created successfully', { id: memory.id });
      
      const responseText = [
        `Memory created successfully.`,
        `ID: ${memory.id}`,
        `Type: ${memory.type}`,
        `Tags: ${JSON.stringify(memory.tags)}`,
        `Confidence: ${memory.confidence}`,
        `Created: ${memory.created_at}`
      ].join('\n');

      return this.createSuccessResponse(id, responseText);
    } catch (error) {
      this.logger.error('Failed to create memory', { error: error.message });
      return this.createErrorResponse(id, -32000, `Failed to create memory: ${error.message}`);
    }
  }

  async handleMemorySearch(id, params) {
    try {
      const validated = this.validator.validateMemorySearch(params);
      this.logger.info('Searching memories', validated);

      const embedding = await this.embeddings.generateEmbedding(validated.query);
      const memories = await this.db.searchMemories(
        embedding,
        validated.type,
        validated.tags,
        validated.limit
      );

      this.logger.info('Search completed', { resultCount: memories.length });

      if (memories.length === 0) {
        return this.createSuccessResponse(id, 'No memories found matching your search.');
      }

      const responseText = `Found ${memories.length} memories:\n\n` + 
        memories.map(memory => [
          `ID: ${memory.id}`,
          `Type: ${memory.type}`,
          `Similarity: ${memory.similarity?.toFixed(3) || 'N/A'}`,
          `Content: ${JSON.stringify(memory.content)}`,
          `Tags: ${JSON.stringify(memory.tags)}`,
          `Created: ${memory.created_at}`,
          ''
        ].join('\n')).join('\n');

      return this.createSuccessResponse(id, responseText);
    } catch (error) {
      this.logger.error('Search failed', { error: error.message });
      return this.createErrorResponse(id, -32000, `Search failed: ${error.message}`);
    }
  }

  async handleMemoryList(id, params) {
    try {
      const validated = this.validator.validateMemoryList(params);
      this.logger.info('Listing memories', validated);

      const memories = await this.db.listMemories(validated.type, validated.tags);
      this.logger.info('List completed', { resultCount: memories.length });

      if (memories.length === 0) {
        return this.createSuccessResponse(id, 'No memories found.');
      }

      const responseText = `Found ${memories.length} memories:\n\n` + 
        memories.map(memory => [
          `ID: ${memory.id}`,
          `Type: ${memory.type}`,
          `Content: ${JSON.stringify(memory.content)}`,
          `Tags: ${JSON.stringify(memory.tags)}`,
          `Created: ${memory.created_at}`,
          ''
        ].join('\n')).join('\n');

      return this.createSuccessResponse(id, responseText);
    } catch (error) {
      this.logger.error('List failed', { error: error.message });
      return this.createErrorResponse(id, -32000, `List failed: ${error.message}`);
    }
  }

  async handleToolCall(id, params) {
    const toolName = params.name;
    const toolArgs = params.arguments || params.input || {};
    
    // Normalize tool name
    const normalized = String(toolName || '')
      .split('/').pop()
      .replaceAll('.', '_');

    this.logger.debug('Tool call', { toolName, normalized, toolArgs });

    switch (normalized) {
      case 'memory_create':
        return await this.handleMemoryCreate(id, toolArgs);
      case 'memory_search':
        return await this.handleMemorySearch(id, toolArgs);
      case 'memory_list':
        return await this.handleMemoryList(id, toolArgs);
      default:
        this.logger.warn('Unknown tool', { tool: toolName });
        return this.createErrorResponse(id, -32601, `Tool not found: ${toolName}`);
    }
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

  async initialize() {
    try {
      // Initialize configuration
      this.config = new Config();
      
      // Initialize logger
      this.logger = new Logger(this.config);
      
      // Initialize components
      this.db = new DatabaseManager(this.config, this.logger);
      this.embeddings = new EmbeddingsManager(this.config, this.logger);
      this.validator = new Validator(this.config);
      this.mcpHandler = new MCPProtocolHandler(
        this.config, 
        this.logger, 
        this.db, 
        this.embeddings, 
        this.validator
      );

      // Setup stdio
      this.setupStdio();
      
      // Setup graceful shutdown
      this.setupGracefulShutdown();
      
      this.logger.info('Memory server started successfully', {
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform
      });

    } catch (error) {
      console.error(`Failed to initialize server: ${error.message}`);
      process.exit(1);
    }
  }

  setupStdio() {
    this.rl = readline.createInterface({ 
      input: process.stdin, 
      crlfDelay: Infinity 
    });

    process.stdin.setEncoding('utf8');
    process.stdout.setDefaultEncoding('utf8');

    this.rl.on('line', this.handleMessage.bind(this));
    this.rl.on('close', () => {
      this.logger.info('readline interface closed');
    });

    process.stdin.on('error', (error) => {
      this.logger.error('stdin error', { error: error.message });
    });

    process.stdout.on('error', (error) => {
      this.logger.error('stdout error', { error: error.message });
    });
  }

  async handleMessage(line) {
    try {
      this.logger.debug('Received message', { length: line.length });
      
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.logger.error('Failed to parse JSON', { error: error.message, line: line.slice(0, 100) });
        return; // Don't respond to parse errors
      }

      const { jsonrpc, id, method, params = {} } = message;

      // Handle notifications (no response needed)
      if (id === undefined || id === null) {
        if (method === 'initialized' || method === 'notifications/initialized') {
          this.logger.info('Received initialized notification');
        } else {
          this.logger.info(`Received notification: ${method}`);
        }
        return;
      }

      // Validate JSON-RPC version
      if (jsonrpc !== "2.0") {
        const response = {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32600,
            message: "Invalid Request: jsonrpc version must be 2.0"
          }
        };
        this.sendResponse(response);
        return;
      }

      // Handle methods
      let response;
      
      switch (method) {
        case 'initialize':
          response = await this.mcpHandler.handleInitialize(id, params);
          break;
        case 'tools/list':
        case 'listTools':
          response = this.mcpHandler.handleListTools(id);
          break;
        case 'tools/call':
        case 'callTool':
          if (!this.mcpHandler.isInitialized) {
            response = this.mcpHandler.createErrorResponse(id, -32002, "Server not initialized");
            break;
          }
          response = await this.mcpHandler.handleToolCall(id, params);
          break;
        case 'resources/list':
        case 'listResources':
          response = { jsonrpc: "2.0", id, result: { resources: [] } };
          break;
        case 'prompts/list':
        case 'listPrompts':
          response = { jsonrpc: "2.0", id, result: { prompts: [] } };
          break;
        default:
          this.logger.warn('Unknown method', { method });
          response = this.mcpHandler.createErrorResponse(id, -32601, `Method not found: ${method}`);
      }

      if (response) {
        this.sendResponse(response);
      }

    } catch (error) {
      this.logger.error('Error handling message', { error: error.message, stack: error.stack });
    }
  }

  sendResponse(response) {
    try {
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (error) {
      this.logger.error('Failed to send response', { error: error.message });
    }
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      this.logger.info(`Received ${signal}, shutting down gracefully...`);
      
      if (this.rl) this.rl.close();
      if (this.db) await this.db.close();
      
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
server.initialize().catch(error => {
  console.error(`Fatal error during server initialization: ${error.message}`);
  process.exit(1);
});
