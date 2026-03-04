import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MCPProtocolHandler } from '../../src/protocol.js';

const makeConfig = () => ({
  server: {
    name: 'memory',
    version: '1.0.0',
    displayName: 'Memory Server',
    description: 'Test server',
    publisher: 'Test',
    protocolVersion: '2024-11-05',
  },
  logging: { levels: ['error', 'warn', 'info', 'debug'] },
  search: { defaultLimit: 10, maxLimit: 100 },
});

const makeLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const makeDb = () => ({
  upsertMemory: vi.fn(),
  searchMemories: vi.fn(),
  listMemories: vi.fn(),
  getMemoryById: vi.fn(),
});

const makeEmbeddings = () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
});

const makeValidator = () => ({
  validateMemoryCreate: vi.fn(p => ({
    type: p.type,
    content: p.content,
    source: p.source,
    tags: p.tags ?? [],
    confidence: p.confidence,
  })),
  validateMemorySearch: vi.fn(p => ({
    query: p.query,
    limit: p.limit ?? 10,
    type: p.type,
    tags: p.tags,
  })),
  validateMemoryList: vi.fn(p => p ?? {}),
  validateMemoryGet: vi.fn(p => ({ id: p.id })),
});

describe('MCPProtocolHandler', () => {
  let handler;

  beforeEach(() => {
    handler = new MCPProtocolHandler({
      config: makeConfig(),
      logger: makeLogger(),
      databaseManager: makeDb(),
      embeddingsManager: makeEmbeddings(),
      validator: makeValidator(),
    });
  });

  // ─── stableStringifyDeep ───────────────────────────────────────────────────

  describe('stableStringifyDeep', () => {
    it('produces consistent output regardless of key order', () => {
      const a = handler.stableStringifyDeep({ b: 1, a: 2 });
      const b = handler.stableStringifyDeep({ a: 2, b: 1 });
      expect(a).toBe(b);
    });

    it('handles nested objects', () => {
      const result = handler.stableStringifyDeep({ outer: { z: 1, a: 2 } });
      expect(result).toContain('"a":');
      expect(result.indexOf('"a":')).toBeLessThan(result.indexOf('"z":'));
    });

    it('handles arrays preserving order', () => {
      expect(handler.stableStringifyDeep([3, 1, 2])).toBe('[3,1,2]');
    });

    it('filters out undefined values', () => {
      const result = handler.stableStringifyDeep({ a: 1, b: undefined });
      expect(result).not.toContain('b');
    });

    it('handles primitive types', () => {
      expect(handler.stableStringifyDeep(42)).toBe('42');
      expect(handler.stableStringifyDeep('hello')).toBe('"hello"');
      expect(handler.stableStringifyDeep(true)).toBe('true');
      expect(handler.stableStringifyDeep(null)).toBe('null');
    });
  });

  // ─── computeContentHash ────────────────────────────────────────────────────

  describe('computeContentHash', () => {
    it('returns a Buffer', () => {
      const hash = handler.computeContentHash({ type: 't', source: 's', content: {} });
      expect(Buffer.isBuffer(hash)).toBe(true);
    });

    it('produces identical hashes for same content in different key order', () => {
      const h1 = handler.computeContentHash({ type: 't', source: 's', content: { b: 2, a: 1 } });
      const h2 = handler.computeContentHash({ type: 't', source: 's', content: { a: 1, b: 2 } });
      expect(h1).toEqual(h2);
    });

    it('produces different hashes for different content', () => {
      const h1 = handler.computeContentHash({ type: 't', source: 's', content: { a: 1 } });
      const h2 = handler.computeContentHash({ type: 't', source: 's', content: { a: 2 } });
      expect(h1).not.toEqual(h2);
    });
  });

  // ─── isClaudeDesktop ───────────────────────────────────────────────────────

  describe('isClaudeDesktop', () => {
    it('returns false when clientInfo is null', () => {
      handler.clientInfo = null;
      expect(handler.isClaudeDesktop()).toBe(false);
    });

    it('returns true for claude-ai client name', () => {
      handler.clientInfo = { name: 'claude-ai' };
      expect(handler.isClaudeDesktop()).toBe(true);
    });

    it('returns true for "Claude Desktop" variant', () => {
      handler.clientInfo = { name: 'Claude Desktop App' };
      expect(handler.isClaudeDesktop()).toBe(true);
    });

    it('returns false for claude-code', () => {
      handler.clientInfo = { name: 'claude-code' };
      expect(handler.isClaudeDesktop()).toBe(false);
    });
  });

  // ─── handleInitialize ──────────────────────────────────────────────────────

  describe('handleInitialize', () => {
    it('returns server info and capabilities', () => {
      const response = handler.handleInitialize(1, { protocolVersion: '2024-11-05' });
      expect(response.result.serverInfo.name).toBe('memory');
      expect(response.result.capabilities.tools).toBeDefined();
    });

    it('stores clientInfo from params', () => {
      handler.handleInitialize(1, {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'claude-ai' },
      });
      expect(handler.clientInfo).toEqual({ name: 'claude-ai' });
    });

    it('returns error on second initialize call', () => {
      handler.handleInitialize(1, {});
      const response = handler.handleInitialize(2, {});
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32002);
    });
  });

  // ─── createSuccessResponse ─────────────────────────────────────────────────

  describe('createSuccessResponse', () => {
    it('wraps array structured content in items object', () => {
      const response = handler.createSuccessResponse(1, 'text', [{ id: 'a' }]);
      expect(response.result.structuredContent).toEqual({ items: [{ id: 'a' }] });
    });

    it('passes object structured content through unchanged', () => {
      const structured = { id: 'x', type: 'note' };
      const response = handler.createSuccessResponse(1, 'text', structured);
      expect(response.result.structuredContent).toEqual(structured);
    });

    it('omits structuredContent when undefined', () => {
      const response = handler.createSuccessResponse(1, 'text', undefined);
      expect(response.result.structuredContent).toBeUndefined();
    });
  });

  // ─── handleListTools ───────────────────────────────────────────────────────

  describe('handleListTools', () => {
    it('returns all four tools', () => {
      const response = handler.handleListTools(1);
      const names = response.result.tools.map(t => t.name);
      expect(names).toContain('memory_create');
      expect(names).toContain('memory_search');
      expect(names).toContain('memory_list');
      expect(names).toContain('memory_get');
    });

    it('each tool has an inputSchema', () => {
      const response = handler.handleListTools(1);
      for (const tool of response.result.tools) {
        expect(tool.inputSchema).toBeDefined();
      }
    });
  });

  // ─── handleToolCall routing ────────────────────────────────────────────────

  describe('handleToolCall', () => {
    it('returns error for unknown tool', async () => {
      const response = await handler.handleToolCall(1, { name: 'unknown_tool', arguments: {} });
      expect(response.error.code).toBe(-32601);
    });

    it('routes memory_create to handleMemoryCreate', async () => {
      handler.db.upsertMemory.mockResolvedValue({
        id: 'uuid-1',
        type: 'note',
        tags: [],
        confidence: 1,
        created_at: new Date(),
      });
      const response = await handler.handleToolCall(1, {
        name: 'memory_create',
        arguments: { type: 'note', content: {}, source: 's', confidence: 1 },
      });
      expect(response.result).toBeDefined();
    });

    it('normalizes dot-separated tool names', async () => {
      handler.db.upsertMemory.mockResolvedValue({
        id: 'uuid-2',
        type: 'note',
        tags: [],
        confidence: 1,
        created_at: new Date(),
      });
      // e.g. "tools/memory.create" → normalized to "memory_create"
      const response = await handler.handleToolCall(1, {
        name: 'memory.create',
        arguments: { type: 'note', content: {}, source: 's', confidence: 1 },
      });
      expect(response.result).toBeDefined();
    });
  });

  // ─── handleMemorySearch ────────────────────────────────────────────────────

  describe('handleMemorySearch', () => {
    it('returns "No memories found" when db returns empty', async () => {
      handler.db.searchMemories.mockResolvedValue([]);
      const response = await handler.handleMemorySearch(1, { query: 'test' });
      expect(response.result.content[0].text).toContain('No memories found');
    });

    it('returns memories with structuredContent when results exist', async () => {
      handler.db.searchMemories.mockResolvedValue([
        { id: 'u1', type: 'note', similarity: 0.9, tags: ['t'], created_at: new Date() },
      ]);
      const response = await handler.handleMemorySearch(1, { query: 'test' });
      expect(response.result.structuredContent.items).toHaveLength(1);
    });

    it('omits resource links for Claude Desktop client', async () => {
      handler.clientInfo = { name: 'claude-ai' };
      handler.db.searchMemories.mockResolvedValue([
        { id: 'u1', type: 'note', similarity: 0.9, tags: [], created_at: new Date() },
      ]);
      const response = await handler.handleMemorySearch(1, { query: 'test' });
      const hasResourceLink = response.result.content.some(c => c.type === 'resource_link');
      expect(hasResourceLink).toBe(false);
    });

    it('includes resource links for non-Desktop clients', async () => {
      handler.clientInfo = { name: 'claude-code' };
      handler.db.searchMemories.mockResolvedValue([
        { id: 'u1', type: 'note', similarity: 0.9, tags: [], created_at: new Date() },
      ]);
      const response = await handler.handleMemorySearch(1, { query: 'test' });
      const hasResourceLink = response.result.content.some(c => c.type === 'resource_link');
      expect(hasResourceLink).toBe(true);
    });
  });

  // ─── handleMemoryGet ───────────────────────────────────────────────────────

  describe('handleMemoryGet', () => {
    const validUUID = '550e8400-e29b-41d4-a716-446655440000';

    it('returns error when memory not found', async () => {
      handler.db.getMemoryById.mockResolvedValue(null);
      const response = await handler.handleMemoryGet(1, { id: validUUID });
      expect(response.error).toBeDefined();
      expect(response.error.message).toContain('Memory not found');
    });

    it('returns memory data when found', async () => {
      const fakeMemory = {
        id: validUUID,
        type: 'note',
        content: { text: 'hi' },
        source: 's',
        tags: [],
        confidence: 1,
        created_at: new Date(),
        updated_at: new Date(),
      };
      handler.db.getMemoryById.mockResolvedValue(fakeMemory);
      const response = await handler.handleMemoryGet(1, { id: validUUID });
      expect(response.result.structuredContent.id).toBe(validUUID);
      expect(response.result.structuredContent.content).toEqual({ text: 'hi' });
    });
  });

  // ─── parseLimit ────────────────────────────────────────────────────────────

  describe('parseLimit', () => {
    it('returns 20 for null input', () => {
      expect(handler.parseLimit(null)).toBe(20);
    });

    it('clamps to min=1', () => {
      expect(handler.parseLimit('0')).toBe(1);
    });

    it('clamps to max=100', () => {
      expect(handler.parseLimit('999')).toBe(100);
    });

    it('parses valid number', () => {
      expect(handler.parseLimit('15')).toBe(15);
    });
  });
});
