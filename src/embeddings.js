import crypto from 'crypto';
import { pipeline } from '@xenova/transformers';

export class EmbeddingsError extends Error {
  constructor(message, originalError) {
    super(message);
    this.name = 'EmbeddingsError';
    this.originalError = originalError;
  }
}

export class EmbeddingsManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.embedder = null;
    this.isInitializing = false;

    this.cache = new Map();
    this.maxCache = parseInt(process.env.EMBEDDINGS_CACHE_SIZE ?? '500', 10);
  }

  cacheKey(text) {
    return (
      crypto.createHash('sha256').update(text).digest('hex') + '::' + this.config.embeddings.model
    );
  }

  getFromCache(key) {
    const hit = this.cache.get(key);
    if (!hit) {
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, hit); // LRU bump
    return hit;
  }

  putToCache(key, vec) {
    this.cache.set(key, vec);
    if (this.cache.size > this.maxCache) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  prepareContentForEmbedding(content) {
    if (typeof content === 'string') {
      return content;
    }
    return JSON.stringify(content);
  }

  async initializeEmbedder() {
    if (this.embedder) {
      return this.embedder;
    }

    if (this.isInitializing) {
      this.logger.info('Waiting for embedder initialization...');
      while (!this.embedder && this.isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return this.embedder;
    }

    this.isInitializing = true;

    try {
      this.logger.info('Initializing embedder...', { model: this.config.embeddings.model });
      this.embedder = await pipeline('feature-extraction', this.config.embeddings.model);
      this.logger.info('Embedder initialized successfully');
      return this.embedder;
    } catch (error) {
      this.logger.error('Failed to initialize embedder', { error: error.message });
      this.isInitializing = false;
      throw new EmbeddingsError('Failed to initialize embedder', error);
    } finally {
      this.isInitializing = false;
    }
  }

  async generateEmbedding(text, retryCount = 0) {
    const key = this.cacheKey(text);
    const cached = this.getFromCache(key);
    if (cached) {
      this.logger.debug('Embedding cache hit', { textLength: text.length });
      return cached;
    }
    try {
      const model = await this.initializeEmbedder();
      const output = await model(text, {
        pooling: this.config.embeddings.pooling,
        normalize: this.config.embeddings.normalize,
      });

      const vec = Array.from(output.data);
      this.putToCache(key, vec);
      this.logger.debug('Generated embedding', { textLength: text.length });
      return vec;
    } catch (error) {
      this.logger.error('Failed to generate embedding', {
        error: error.message,
        retryCount,
        textLength: text.length,
      });

      if (retryCount < this.config.embeddings.maxRetries) {
        this.logger.info(
          `Retrying embedding generation (${retryCount + 1}/${this.config.embeddings.maxRetries})`
        );
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        return this.generateEmbedding(text, retryCount + 1);
      }

      throw new EmbeddingsError('Failed to generate embedding after retries', error);
    }
  }
}
