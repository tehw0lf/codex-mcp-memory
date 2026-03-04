import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class Config {
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
