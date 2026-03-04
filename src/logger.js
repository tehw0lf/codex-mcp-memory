import fs from 'fs';
import path from 'path';

export class Logger {
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
      fs.mkdirSync(dir, { recursive: true });
      const content = `[${timestamp}] Memory server starting - Log level: ${this.config.logging.level}\n`;
      fs.writeFileSync(this.config.logging.debugFile, content);
    } catch (error) {
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
      fs.appendFileSync(this.config.logging.debugFile, logLine);
    } catch (error) {
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
