import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EmbeddingsManager, EmbeddingsError } from '../../src/embeddings.js';

// Mock @xenova/transformers so tests don't download a 90MB model
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(),
}));

import { pipeline } from '@xenova/transformers';

const makeConfig = () => ({
  embeddings: {
    model: 'Xenova/all-MiniLM-L6-v2',
    pooling: 'mean',
    normalize: true,
    maxRetries: 2,
  },
});

const makeLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const makeFakeEmbedder = (vec = [0.1, 0.2, 0.3]) =>
  vi.fn().mockResolvedValue({ data: Float32Array.from(vec) });

describe('EmbeddingsManager', () => {
  let manager;
  let logger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = makeLogger();
    manager = new EmbeddingsManager(makeConfig(), logger);
  });

  // ─── cacheKey ──────────────────────────────────────────────────────────────

  describe('cacheKey', () => {
    it('returns a string containing the model name', () => {
      const key = manager.cacheKey('hello');
      expect(key).toContain('Xenova/all-MiniLM-L6-v2');
    });

    it('produces different keys for different texts', () => {
      expect(manager.cacheKey('a')).not.toBe(manager.cacheKey('b'));
    });

    it('produces the same key for the same text', () => {
      expect(manager.cacheKey('x')).toBe(manager.cacheKey('x'));
    });
  });

  // ─── LRU cache ─────────────────────────────────────────────────────────────

  describe('LRU cache', () => {
    it('stores and retrieves a value', () => {
      const key = 'k1';
      manager.putToCache(key, [1, 2, 3]);
      expect(manager.getFromCache(key)).toEqual([1, 2, 3]);
    });

    it('returns null on cache miss', () => {
      expect(manager.getFromCache('missing')).toBeNull();
    });

    it('evicts the oldest entry when cache is full', () => {
      manager.maxCache = 2;
      manager.putToCache('a', [1]);
      manager.putToCache('b', [2]);
      manager.putToCache('c', [3]); // should evict 'a'
      expect(manager.getFromCache('a')).toBeNull();
      expect(manager.getFromCache('b')).toEqual([2]);
      expect(manager.getFromCache('c')).toEqual([3]);
    });

    it('bumps accessed key to most-recent on get', () => {
      manager.maxCache = 2;
      manager.putToCache('a', [1]);
      manager.putToCache('b', [2]);
      // Access 'a' to make it recent
      manager.getFromCache('a');
      // Adding 'c' should evict 'b' (least recently used), not 'a'
      manager.putToCache('c', [3]);
      expect(manager.getFromCache('a')).toEqual([1]);
      expect(manager.getFromCache('b')).toBeNull();
    });
  });

  // ─── prepareContentForEmbedding ────────────────────────────────────────────

  describe('prepareContentForEmbedding', () => {
    it('returns string as-is', () => {
      expect(manager.prepareContentForEmbedding('hello')).toBe('hello');
    });

    it('JSON.stringifies non-strings', () => {
      expect(manager.prepareContentForEmbedding({ a: 1 })).toBe('{"a":1}');
    });
  });

  // ─── generateEmbedding ─────────────────────────────────────────────────────

  describe('generateEmbedding', () => {
    it('returns a vector array from the model', async () => {
      const embedder = makeFakeEmbedder([0.1, 0.2]);
      pipeline.mockResolvedValue(embedder);

      const result = await manager.generateEmbedding('hello');
      // Float32Array → Array.from causes minor precision loss, use toBeCloseTo
      expect(result).toHaveLength(2);
      expect(result[0]).toBeCloseTo(0.1, 5);
      expect(result[1]).toBeCloseTo(0.2, 5);
    });

    it('returns cached result on second call without calling the model', async () => {
      const embedder = makeFakeEmbedder([0.5]);
      pipeline.mockResolvedValue(embedder);

      await manager.generateEmbedding('hello');
      await manager.generateEmbedding('hello');

      expect(embedder).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and eventually succeeds', async () => {
      const embedder = vi
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({ data: Float32Array.from([0.9]) });
      pipeline.mockResolvedValue(embedder);

      const result = await manager.generateEmbedding('hello');
      expect(result[0]).toBeCloseTo(0.9, 5);
      expect(embedder).toHaveBeenCalledTimes(2);
    });

    it('throws EmbeddingsError after all retries are exhausted', async () => {
      const embedder = vi.fn().mockRejectedValue(new Error('always fails'));
      pipeline.mockResolvedValue(embedder);

      await expect(manager.generateEmbedding('hello')).rejects.toThrow(EmbeddingsError);
      // maxRetries=2 → initial + 2 retries = 3 total calls
      expect(embedder).toHaveBeenCalledTimes(3);
    }, 15000); // retries include delays — increase timeout
  });

  // ─── initializeEmbedder ────────────────────────────────────────────────────

  describe('initializeEmbedder', () => {
    it('only calls pipeline once even with concurrent calls', async () => {
      const embedder = makeFakeEmbedder();
      pipeline.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(embedder), 50))
      );

      const [a, b] = await Promise.all([
        manager.initializeEmbedder(),
        manager.initializeEmbedder(),
      ]);

      expect(pipeline).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
    });

    it('throws EmbeddingsError when pipeline fails', async () => {
      pipeline.mockRejectedValue(new Error('model not found'));
      await expect(manager.initializeEmbedder()).rejects.toThrow(EmbeddingsError);
    });
  });
});
