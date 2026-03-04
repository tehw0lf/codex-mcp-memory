import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Config, ConfigurationError } from '../../src/config.js';

describe('Config', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateRequiredEnvVars', () => {
    it('throws ConfigurationError when DATABASE_URL is missing', () => {
      delete process.env.DATABASE_URL;
      expect(() => new Config()).toThrow(ConfigurationError);
      expect(() => new Config()).toThrow('DATABASE_URL environment variable is required');
    });

    it('succeeds when DATABASE_URL is set', () => {
      expect(() => new Config()).not.toThrow();
    });
  });

  describe('initializeServer', () => {
    it('uses default values when env vars are not set', () => {
      const config = new Config();
      expect(config.server.name).toBe('memory');
      expect(config.server.version).toBe('1.0.0');
      expect(config.server.protocolVersion).toBe('2024-11-05');
    });

    it('uses env var values when set', () => {
      process.env.MCP_SERVER_NAME = 'my-server';
      process.env.MCP_SERVER_VERSION = '2.0.0';
      const config = new Config();
      expect(config.server.name).toBe('my-server');
      expect(config.server.version).toBe('2.0.0');
    });
  });

  describe('initializeDb', () => {
    it('uses default pool size when not set', () => {
      const config = new Config();
      expect(config.db.maxPoolSize).toBe(20);
    });

    it('clamps pool size to min=1', () => {
      process.env.DB_MAX_POOL_SIZE = '0';
      const config = new Config();
      expect(config.db.maxPoolSize).toBe(1);
    });

    it('clamps pool size to max=100', () => {
      process.env.DB_MAX_POOL_SIZE = '999';
      const config = new Config();
      expect(config.db.maxPoolSize).toBe(100);
    });

    it('falls back to default for non-numeric value', () => {
      process.env.DB_MAX_POOL_SIZE = 'abc';
      const config = new Config();
      expect(config.db.maxPoolSize).toBe(20);
    });
  });

  describe('initializeSecurity', () => {
    it('uses default maxContentLength', () => {
      const config = new Config();
      expect(config.security.maxContentLength).toBe(10000);
    });

    it('uses default maxTagsCount', () => {
      const config = new Config();
      expect(config.security.maxTagsCount).toBe(20);
    });

    it('respects custom maxTagsCount within bounds', () => {
      process.env.MAX_TAGS_COUNT = '50';
      const config = new Config();
      expect(config.security.maxTagsCount).toBe(50);
    });
  });

  describe('initializeEmbeddings', () => {
    it('normalize defaults to true', () => {
      const config = new Config();
      expect(config.embeddings.normalize).toBe(true);
    });

    it('normalize can be disabled', () => {
      process.env.EMBEDDINGS_NORMALIZE = 'false';
      const config = new Config();
      expect(config.embeddings.normalize).toBe(false);
    });
  });

  describe('initializeSearch', () => {
    it('uses default search limits', () => {
      const config = new Config();
      expect(config.search.defaultLimit).toBe(10);
      expect(config.search.maxLimit).toBe(100);
    });
  });

  describe('parseIntWithDefault', () => {
    it('returns defaultValue when value is undefined', () => {
      const config = new Config();
      expect(
        config.parseIntWithDefault({ value: undefined, defaultValue: 5, min: 1, max: 10 })
      ).toBe(5);
    });

    it('clamps to min', () => {
      const config = new Config();
      expect(config.parseIntWithDefault({ value: '-5', defaultValue: 5, min: 1, max: 10 })).toBe(1);
    });

    it('clamps to max', () => {
      const config = new Config();
      expect(config.parseIntWithDefault({ value: '100', defaultValue: 5, min: 1, max: 10 })).toBe(
        10
      );
    });

    it('returns parsed value within bounds', () => {
      const config = new Config();
      expect(config.parseIntWithDefault({ value: '7', defaultValue: 5, min: 1, max: 10 })).toBe(7);
    });
  });
});
