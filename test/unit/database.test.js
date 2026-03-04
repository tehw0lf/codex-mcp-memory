import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseManager, DatabaseError } from '../../src/database.js';

// Mock pg with a real class so `new Pool()` works as a constructor
vi.mock('pg', () => {
  class Pool {
    constructor() {
      this.connect = vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({}),
        release: vi.fn(),
      });
      this.query = vi.fn().mockResolvedValue({ rows: [] });
      this.end = vi.fn().mockResolvedValue(undefined);
    }
  }
  return { default: { Pool } };
});

const makeConfig = () => ({
  db: {
    connectionString: 'postgresql://test:test@localhost:5432/test',
    maxPoolSize: 5,
    idleTimeout: 10000,
    queryTimeout: 10000,
  },
  embeddings: { normalize: true },
});

const makeLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

/** Create a pre-initialized DatabaseManager with an injected fake pool. */
function makeInitializedManager(poolOverrides = {}) {
  const logger = makeLogger();
  const manager = new DatabaseManager(makeConfig(), logger);
  const fakePool = {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    }),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
    ...poolOverrides,
  };
  // Bypass initialize() — inject pool directly
  manager.pool = fakePool;
  manager.isInitialized = true;
  return { manager, pool: fakePool, logger };
}

describe('DatabaseManager', () => {
  // ─── initialize ────────────────────────────────────────────────────────────

  describe('initialize', () => {
    it('marks isInitialized after successful init', async () => {
      const manager = new DatabaseManager(makeConfig(), makeLogger());
      // The vi.mock default pool works here
      await manager.initialize();
      expect(manager.isInitialized).toBe(true);
    });

    it('logs a warning when embeddings normalization is OFF', async () => {
      const config = makeConfig();
      config.embeddings.normalize = false;
      const logger = makeLogger();
      const manager = new DatabaseManager(config, logger);
      await manager.initialize();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('normalization is OFF'));
    });
  });

  // ─── buildSearchQuery ──────────────────────────────────────────────────────

  describe('buildSearchQuery', () => {
    let manager;

    beforeEach(() => {
      ({ manager } = makeInitializedManager());
    });

    it('builds base query without type/tags filters', () => {
      const { sqlQuery, queryParams } = manager.buildSearchQuery({
        embedding: [0.1, 0.2],
        limit: 10,
      });
      expect(sqlQuery).toContain('embedding <#>');
      expect(sqlQuery).toContain('ORDER BY similarity DESC');
      expect(queryParams).toHaveLength(2);
    });

    it('adds type filter when provided', () => {
      const { sqlQuery, queryParams } = manager.buildSearchQuery({
        embedding: [0.1],
        type: 'note',
        limit: 5,
      });
      expect(sqlQuery).toContain('AND type =');
      expect(queryParams).toContain('note');
    });

    it('adds tags filter when provided', () => {
      const { sqlQuery, queryParams } = manager.buildSearchQuery({
        embedding: [0.1],
        tags: ['tag1'],
        limit: 5,
      });
      expect(sqlQuery).toContain('AND tags &&');
      expect(queryParams).toContainEqual(['tag1']);
    });

    it('adds both type and tags filters', () => {
      const { sqlQuery, queryParams } = manager.buildSearchQuery({
        embedding: [0.1],
        type: 'note',
        tags: ['t'],
        limit: 5,
      });
      expect(sqlQuery).toContain('AND type =');
      expect(sqlQuery).toContain('AND tags &&');
      expect(queryParams).toHaveLength(4);
    });
  });

  // ─── createMemory ──────────────────────────────────────────────────────────

  describe('createMemory', () => {
    it('calls pool.query and returns the inserted row', async () => {
      const fakeRow = { id: 'uuid-1', type: 'note', tags: [] };
      const { manager, pool } = makeInitializedManager({
        query: vi.fn().mockResolvedValue({ rows: [fakeRow] }),
      });

      const result = await manager.createMemory({
        type: 'note',
        content: { text: 'hello' },
        source: 'test',
        embedding: [0.1, 0.2],
        tags: ['a'],
        confidence: 0.9,
      });

      expect(result).toEqual(fakeRow);
      expect(pool.query).toHaveBeenCalled();
    });

    it('throws DatabaseError on query failure', async () => {
      const { manager } = makeInitializedManager({
        query: vi.fn().mockRejectedValue(new Error('query failed')),
      });

      await expect(
        manager.createMemory({
          type: 'note',
          content: {},
          source: 's',
          embedding: [0.1],
          tags: [],
          confidence: 1,
        })
      ).rejects.toThrow(DatabaseError);
    });
  });

  // ─── searchMemories ────────────────────────────────────────────────────────

  describe('searchMemories', () => {
    it('returns rows from the query', async () => {
      const fakeRows = [{ id: 'u1', similarity: '0.9' }];
      const { manager } = makeInitializedManager({
        query: vi.fn().mockResolvedValue({ rows: fakeRows }),
      });

      const result = await manager.searchMemories({ embedding: [0.1], limit: 5 });
      expect(result).toEqual(fakeRows);
    });

    it('throws DatabaseError on query failure', async () => {
      const { manager } = makeInitializedManager({
        query: vi.fn().mockRejectedValue(new Error('search failed')),
      });

      await expect(manager.searchMemories({ embedding: [0.1], limit: 5 })).rejects.toThrow(
        DatabaseError
      );
    });
  });

  // ─── listMemories ──────────────────────────────────────────────────────────

  describe('listMemories', () => {
    it('returns rows ordered by created_at from pool', async () => {
      const fakeRows = [{ id: 'u1' }, { id: 'u2' }];
      const { manager } = makeInitializedManager({
        query: vi.fn().mockResolvedValue({ rows: fakeRows }),
      });

      const result = await manager.listMemories();
      expect(result).toEqual(fakeRows);
    });
  });

  // ─── getMemoryById ─────────────────────────────────────────────────────────

  describe('getMemoryById', () => {
    it('returns the row when found', async () => {
      const fakeRow = { id: 'uuid-1', type: 'note' };
      const { manager } = makeInitializedManager({
        query: vi.fn().mockResolvedValue({ rows: [fakeRow] }),
      });

      const result = await manager.getMemoryById('uuid-1');
      expect(result).toEqual(fakeRow);
    });

    it('returns null when row not found', async () => {
      const { manager } = makeInitializedManager({
        query: vi.fn().mockResolvedValue({ rows: [] }),
      });

      const result = await manager.getMemoryById('unknown-id');
      expect(result).toBeNull();
    });
  });

  // ─── close ─────────────────────────────────────────────────────────────────

  describe('close', () => {
    it('calls pool.end and resets state', async () => {
      const { manager, pool } = makeInitializedManager();
      await manager.close();
      expect(pool.end).toHaveBeenCalled();
      expect(manager.isInitialized).toBe(false);
      expect(manager.pool).toBeNull();
    });

    it('is a no-op when pool is null', async () => {
      const manager = new DatabaseManager(makeConfig(), makeLogger());
      await expect(manager.close()).resolves.not.toThrow();
    });
  });
});
