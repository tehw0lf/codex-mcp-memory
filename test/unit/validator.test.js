import { describe, it, expect, beforeEach } from 'vitest';
import { Validator, ValidationError } from '../../src/validator.js';

const makeConfig = (overrides = {}) => ({
  security: { maxContentLength: 10000, maxTagsCount: 20 },
  search: { defaultLimit: 10, maxLimit: 100 },
  ...overrides,
});

describe('Validator', () => {
  let validator;

  beforeEach(() => {
    validator = new Validator(makeConfig());
  });

  // ─── validateMemoryCreate ───────────────────────────────────────────────────

  describe('validateMemoryCreate', () => {
    const validParams = {
      type: 'note',
      content: { text: 'hello' },
      source: 'test',
      confidence: 0.9,
      tags: ['tag1', 'tag2'],
    };

    it('returns sanitized params for valid input', () => {
      const result = validator.validateMemoryCreate(validParams);
      expect(result.type).toBe('note');
      expect(result.content).toEqual({ text: 'hello' });
      expect(result.tags).toEqual(['tag1', 'tag2']);
    });

    it('deduplicates tags', () => {
      const result = validator.validateMemoryCreate({ ...validParams, tags: ['a', 'a', 'b'] });
      expect(result.tags).toEqual(['a', 'b']);
    });

    it('truncates type to 50 chars', () => {
      const longType = 'a'.repeat(60);
      const result = validator.validateMemoryCreate({ ...validParams, type: longType });
      expect(result.type.length).toBe(50);
    });

    it('truncates source to 100 chars', () => {
      const longSource = 'x'.repeat(150);
      const result = validator.validateMemoryCreate({ ...validParams, source: longSource });
      expect(result.source.length).toBe(100);
    });

    it('throws on missing type', () => {
      expect(() => validator.validateMemoryCreate({ ...validParams, type: '' })).toThrow(
        ValidationError
      );
    });

    it('throws on missing content', () => {
      expect(() => validator.validateMemoryCreate({ ...validParams, content: null })).toThrow(
        ValidationError
      );
    });

    it('throws on missing source', () => {
      expect(() => validator.validateMemoryCreate({ ...validParams, source: '' })).toThrow(
        ValidationError
      );
    });

    it('throws when confidence < 0', () => {
      expect(() => validator.validateMemoryCreate({ ...validParams, confidence: -0.1 })).toThrow(
        ValidationError
      );
    });

    it('throws when confidence > 1', () => {
      expect(() => validator.validateMemoryCreate({ ...validParams, confidence: 1.1 })).toThrow(
        ValidationError
      );
    });

    it('throws when tags exceed maxTagsCount', () => {
      const tooManyTags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
      expect(() => validator.validateMemoryCreate({ ...validParams, tags: tooManyTags })).toThrow(
        ValidationError
      );
    });

    it('throws when content exceeds maxContentLength', () => {
      const bigContent = { data: 'x'.repeat(10001) };
      expect(() => validator.validateMemoryCreate({ ...validParams, content: bigContent })).toThrow(
        ValidationError
      );
    });
  });

  // ─── sanitizeTags ───────────────────────────────────────────────────────────

  describe('sanitizeTags', () => {
    it('lowercases tags', () => {
      expect(validator.sanitizeTags(['UPPER', 'Mixed'])).toEqual(['upper', 'mixed']);
    });

    it('accepts tags with allowed special chars (: . _ - /)', () => {
      expect(() =>
        validator.sanitizeTags(['repo:foo', 'branch.main', 'v1_0', 'tag-a', 'feature/my-branch'])
      ).not.toThrow();
    });

    it('throws on tag with invalid characters', () => {
      expect(() => validator.sanitizeTags(['invalid tag!'])).toThrow(ValidationError);
    });

    it('throws on tag that is too long (>100 chars)', () => {
      expect(() => validator.sanitizeTags(['a'.repeat(101)])).toThrow(ValidationError);
    });

    it('returns empty array for no tags', () => {
      expect(validator.sanitizeTags()).toEqual([]);
      expect(validator.sanitizeTags([])).toEqual([]);
    });
  });

  // ─── validateMemorySearch ───────────────────────────────────────────────────

  describe('validateMemorySearch', () => {
    it('returns validated params for valid input', () => {
      const result = validator.validateMemorySearch({ query: 'find me' });
      expect(result.query).toBe('find me');
      expect(result.limit).toBe(10); // default
    });

    it('applies maxLimit cap to limit', () => {
      const result = validator.validateMemorySearch({ query: 'q', limit: 9999 });
      expect(result.limit).toBe(100);
    });

    it('throws on empty query', () => {
      expect(() => validator.validateMemorySearch({ query: '' })).toThrow(ValidationError);
    });

    it('throws on query > 1000 chars', () => {
      expect(() => validator.validateMemorySearch({ query: 'q'.repeat(1001) })).toThrow(
        ValidationError
      );
    });

    it('throws on negative limit', () => {
      expect(() => validator.validateMemorySearch({ query: 'q', limit: -1 })).toThrow(
        ValidationError
      );
    });

    it('includes type when provided', () => {
      const result = validator.validateMemorySearch({ query: 'q', type: 'note' });
      expect(result.type).toBe('note');
    });

    it('validates search tags', () => {
      expect(() => validator.validateMemorySearch({ query: 'q', tags: ['bad tag!'] })).toThrow(
        ValidationError
      );
    });
  });

  // ─── validateMemoryList ─────────────────────────────────────────────────────

  describe('validateMemoryList', () => {
    it('returns empty object when no params', () => {
      expect(validator.validateMemoryList()).toEqual({});
    });

    it('includes type when valid', () => {
      expect(validator.validateMemoryList({ type: 'note' })).toEqual({ type: 'note' });
    });

    it('throws on non-string type', () => {
      expect(() => validator.validateMemoryList({ type: 123 })).toThrow(ValidationError);
    });

    it('normalizes and includes tags', () => {
      const result = validator.validateMemoryList({ tags: ['TAG'] });
      expect(result.tags).toEqual(['tag']);
    });

    it('throws on non-array tags', () => {
      expect(() => validator.validateMemoryList({ tags: 'not-array' })).toThrow(ValidationError);
    });
  });

  // ─── validateMemoryGet ──────────────────────────────────────────────────────

  describe('validateMemoryGet', () => {
    const validUUID = '550e8400-e29b-41d4-a716-446655440000';

    it('returns trimmed id for valid UUID', () => {
      expect(validator.validateMemoryGet({ id: validUUID })).toEqual({ id: validUUID });
    });

    it('trims whitespace from id', () => {
      expect(validator.validateMemoryGet({ id: `  ${validUUID}  ` })).toEqual({ id: validUUID });
    });

    it('throws on missing id', () => {
      expect(() => validator.validateMemoryGet({ id: '' })).toThrow(ValidationError);
    });

    it('throws on non-UUID id', () => {
      expect(() => validator.validateMemoryGet({ id: 'not-a-uuid' })).toThrow(ValidationError);
    });
  });
});
