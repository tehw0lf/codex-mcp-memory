import readline from 'readline';
import { Config } from './config.js';
import { Logger } from './logger.js';
import { Validator } from './validator.js';
import { DatabaseManager } from './database.js';
import { EmbeddingsManager } from './embeddings.js';
import { MCPProtocolHandler } from './protocol.js';

export class MemoryServer {
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
