export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class Validator {
  constructor(config) {
    this.config = config;
    this.TAG_RE = /^[a-z0-9:._/-]{1,100}$/;
  }

  validateMemoryCreate(params) {
    this.validateType(params.type);
    this.validateContent(params.content);
    this.validateSource(params.source);
    this.validateConfidence(params.confidence);
    this.validateTags(params.tags);
    this.validateContentLength(params.content);

    const sanitizedTags = this.sanitizeTags(params.tags);
    const sanitized = {
      type: params.type.trim().slice(0, 50),
      content: params.content,
      source: params.source.trim().slice(0, 100),
      tags: sanitizedTags,
      confidence: params.confidence,
    };

    return sanitized;
  }

  validateType(type) {
    if (!type || typeof type !== 'string' || type.trim().length === 0) {
      throw new ValidationError('type is required and must be a non-empty string');
    }
  }

  validateContent(content) {
    if (!content) {
      throw new ValidationError('content is required');
    }
  }

  validateSource(source) {
    if (!source || typeof source !== 'string' || source.trim().length === 0) {
      throw new ValidationError('source is required and must be a non-empty string');
    }
  }

  validateConfidence(confidence) {
    if (
      confidence === undefined ||
      typeof confidence !== 'number' ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new ValidationError('confidence is required and must be a number between 0 and 1');
    }
  }

  validateTags(tags = []) {
    if (!Array.isArray(tags)) {
      throw new ValidationError('tags must be an array');
    }

    if (tags.length > this.config.security.maxTagsCount) {
      throw new ValidationError(
        `tags array cannot have more than ${this.config.security.maxTagsCount} items`
      );
    }
  }

  validateContentLength(content) {
    const contentStr = JSON.stringify(content);
    if (contentStr.length > this.config.security.maxContentLength) {
      throw new ValidationError(
        `content is too large (max ${this.config.security.maxContentLength} characters)`
      );
    }
  }

  sanitizeTags(tags = []) {
    return Array.from(
      new Set(
        tags.map(tag => {
          const t = String(tag).trim().toLowerCase();
          if (!this.TAG_RE.test(t)) {
            throw new ValidationError(`invalid tag: "${tag}"`);
          }
          return t;
        })
      )
    );
  }

  validateMemorySearch(params) {
    const { query, type, tags, limit } = params;

    this.validateQuery(query);
    const searchLimit = this.validateAndParseLimit(limit);
    const validated = {
      query: query.trim(),
      limit: searchLimit,
    };

    if (type) {
      this.validateType(type);
      validated.type = type.trim().slice(0, 50);
    }

    if (tags) {
      validated.tags = this.validateSearchTags(tags);
    }

    return validated;
  }

  validateQuery(query) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new ValidationError('query is required and must be a non-empty string');
    }

    if (query.length > 1000) {
      throw new ValidationError('query length cannot exceed 1000 characters');
    }
  }

  validateAndParseLimit(limit) {
    let searchLimit = this.config.search.defaultLimit;
    if (limit !== undefined) {
      if (typeof limit !== 'number' || limit < 1) {
        throw new ValidationError('limit must be a positive number');
      }
      searchLimit = Math.min(limit, this.config.search.maxLimit);
    }
    return searchLimit;
  }

  validateSearchTags(tags) {
    if (!Array.isArray(tags)) {
      throw new ValidationError('tags must be an array');
    }
    return tags.map(tag => {
      const t = String(tag).trim().toLowerCase();
      if (!this.TAG_RE.test(t)) {
        throw new ValidationError(`invalid tag: "${tag}"`);
      }
      return t;
    });
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
      validated.tags = tags.map(tag => {
        const t = String(tag).trim().toLowerCase();
        if (!this.TAG_RE.test(t)) {
          throw new ValidationError(`invalid tag: "${tag}"`);
        }
        return t;
      });
    }

    return validated;
  }

  validateMemoryGet(params) {
    const { id } = params;

    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new ValidationError('id is required and must be a non-empty string');
    }

    // Basic UUID format validation (optional but recommended)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const trimmedId = id.trim();

    if (!uuidRegex.test(trimmedId)) {
      throw new ValidationError('id must be a valid UUID format');
    }

    return { id: trimmedId };
  }
}
