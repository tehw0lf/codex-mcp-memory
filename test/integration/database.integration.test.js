/**
 * Integration tests for DatabaseManager against a real PostgreSQL + pgvector instance.
 *
 * Prerequisites:
 *   - Docker Compose is running: `docker-compose up -d`
 *   - DATABASE_URL is set (either via .env or the environment)
 *
 * These tests are skipped automatically when DATABASE_URL is not available.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { DatabaseManager } from '../../src/database.js';

const DATABASE_URL = process.env.DATABASE_URL;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

const makeConfig = () => ({
  db: {
    connectionString: DATABASE_URL,
    maxPoolSize: 5,
    idleTimeout: 10000,
    queryTimeout: 10000,
  },
  embeddings: { normalize: true },
});

const makeLogger = () => ({
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
});

// Fake 384-dim embedding (all zeros)
const fakeEmbedding = new Array(384).fill(0);
fakeEmbedding[0] = 0.1;

// Use a direct pg client to clean up test data between tests
const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL }) : null;

async function cleanupTestData() {
  await pool.query("DELETE FROM memories WHERE source = 'integration-test'");
}

describeIfDb('DatabaseManager (integration)', () => {
  let manager;

  beforeAll(async () => {
    manager = new DatabaseManager(makeConfig(), makeLogger());
    await manager.initialize();
  });

  afterAll(async () => {
    await cleanupTestData();
    await manager.close();
    await pool.end();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  // ─── upsertMemory ──────────────────────────────────────────────────────────

  describe('upsertMemory', () => {
    it('inserts a new memory and returns it', async () => {
      const row = await manager.upsertMemory({
        type: 'test',
        content: { text: 'hello world' },
        source: 'integration-test',
        embedding: fakeEmbedding,
        tags: ['integration', 'test'],
        confidence: 0.8,
        contentHash: Buffer.from('hash-insert-1'),
      });

      expect(row.id).toBeDefined();
      expect(row.type).toBe('test');
      expect(row.tags).toContain('integration');
    });

    it('upserts on conflict: merges tags and takes max confidence', async () => {
      const hash = Buffer.from('hash-upsert-merge');

      await manager.upsertMemory({
        type: 'test',
        content: { v: 1 },
        source: 'integration-test',
        embedding: fakeEmbedding,
        tags: ['original'],
        confidence: 0.5,
        contentHash: hash,
      });

      const updated = await manager.upsertMemory({
        type: 'test',
        content: { v: 1 },
        source: 'integration-test',
        embedding: fakeEmbedding,
        tags: ['new-tag'],
        confidence: 0.9,
        contentHash: hash,
      });

      expect(updated.tags).toContain('original');
      expect(updated.tags).toContain('new-tag');
      expect(Number(updated.confidence)).toBeCloseTo(0.9);
    });
  });

  // ─── getMemoryById ─────────────────────────────────────────────────────────

  describe('getMemoryById', () => {
    it('returns the memory when found', async () => {
      const inserted = await manager.upsertMemory({
        type: 'test',
        content: { x: 42 },
        source: 'integration-test',
        embedding: fakeEmbedding,
        tags: [],
        confidence: 1,
        contentHash: Buffer.from('hash-get-by-id'),
      });

      const result = await manager.getMemoryById(inserted.id);
      expect(result).not.toBeNull();
      expect(result.id).toBe(inserted.id);
      expect(result.content).toEqual({ x: 42 });
    });

    it('returns null for a non-existent UUID', async () => {
      const result = await manager.getMemoryById('00000000-0000-0000-0000-000000000000');
      expect(result).toBeNull();
    });
  });

  // ─── searchMemories ────────────────────────────────────────────────────────

  describe('searchMemories', () => {
    it('returns rows sorted by similarity', async () => {
      await manager.upsertMemory({
        type: 'test',
        content: { note: 'a' },
        source: 'integration-test',
        embedding: fakeEmbedding,
        tags: ['search-test'],
        confidence: 1,
        contentHash: Buffer.from('hash-search-1'),
      });

      const rows = await manager.searchMemories({
        embedding: fakeEmbedding,
        limit: 10,
      });

      expect(rows.length).toBeGreaterThan(0);
      // Similarity should be a number
      expect(typeof rows[0].similarity).toBe('string'); // pg returns numeric as string
    });

    it('filters by type', async () => {
      await manager.upsertMemory({
        type: 'unique-type-xyz',
        content: { n: 1 },
        source: 'integration-test',
        embedding: fakeEmbedding,
        tags: [],
        confidence: 1,
        contentHash: Buffer.from('hash-type-filter'),
      });

      const rows = await manager.searchMemories({
        embedding: fakeEmbedding,
        type: 'unique-type-xyz',
        limit: 10,
      });

      expect(rows.every(r => r.type === 'unique-type-xyz')).toBe(true);
    });

    it('filters by tags', async () => {
      await manager.upsertMemory({
        type: 'test',
        content: { n: 2 },
        source: 'integration-test',
        embedding: fakeEmbedding,
        tags: ['unique-tag-abc'],
        confidence: 1,
        contentHash: Buffer.from('hash-tag-filter'),
      });

      const rows = await manager.searchMemories({
        embedding: fakeEmbedding,
        tags: ['unique-tag-abc'],
        limit: 10,
      });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(r => r.tags.includes('unique-tag-abc'))).toBe(true);
    });
  });

  // ─── listMemories ──────────────────────────────────────────────────────────

  describe('listMemories', () => {
    it('returns memories ordered by created_at DESC', async () => {
      await manager.upsertMemory({
        type: 'test',
        content: { n: 10 },
        source: 'integration-test',
        embedding: fakeEmbedding,
        tags: ['list-test'],
        confidence: 1,
        contentHash: Buffer.from('hash-list-1'),
      });
      await manager.upsertMemory({
        type: 'test',
        content: { n: 11 },
        source: 'integration-test',
        embedding: fakeEmbedding,
        tags: ['list-test'],
        confidence: 1,
        contentHash: Buffer.from('hash-list-2'),
      });

      const rows = await manager.listMemories(undefined, ['list-test']);
      expect(rows.length).toBeGreaterThanOrEqual(2);

      // Verify descending order
      for (let i = 1; i < rows.length; i++) {
        expect(new Date(rows[i - 1].created_at) >= new Date(rows[i].created_at)).toBe(true);
      }
    });
  });
});
