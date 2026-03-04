import pg from 'pg';

const { Pool } = pg;

export class DatabaseError extends Error {
  constructor(message, originalError) {
    super(message);
    this.name = 'DatabaseError';
    this.originalError = originalError;
  }
}

export class DatabaseManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.pool = null;
    this.isInitialized = false;
  }

  async initialize() {
    try {
      this.pool = new Pool({
        connectionString: this.config.db.connectionString,
        max: this.config.db.maxPoolSize,
        idleTimeoutMillis: this.config.db.idleTimeout,
        query_timeout: this.config.db.queryTimeout,
        statement_timeout: this.config.db.queryTimeout,
        application_name: 'mcp-memory',
      });

      // Test connection
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();

      await this.initializeSchema();
      this.isInitialized = true;
      this.logger.info('Database initialized successfully');
      if (!this.config.embeddings.normalize) {
        this.logger.warn(
          'Embeddings normalization is OFF. Cosine similarity (1 - cosine distance) may be less stable.'
        );
      }
    } catch (error) {
      this.logger.error('Failed to initialize database', { error: error.message });
      throw new DatabaseError('Database initialization failed', error);
    }
  }

  initializeSchema() {
    // Schema initialization is handled by Docker's init SQL (docker/db/00-init.sql)
    this.logger.info('Skipping code-based schema migration (handled by Docker init)');
  }

  async ensureInitialized() {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  async createMemory(memoryData) {
    const { type, content, source, embedding, tags, confidence } = memoryData;
    await this.ensureInitialized();

    try {
      const query = `
        INSERT INTO memories (type, content, source, embedding, tags, confidence)
        VALUES ($1, $2::jsonb, $3, $4::vector, $5, $6)
        RETURNING id, type, content, source, tags, confidence, created_at, updated_at
      `;

      const result = await this.pool.query(query, [
        type,
        JSON.stringify(content),
        source,
        `[${embedding.join(',')}]`,
        tags,
        confidence,
      ]);

      return result.rows[0];
    } catch (error) {
      this.logger.error('Failed to create memory', { error: error.message });
      throw new DatabaseError('Failed to create memory', error);
    }
  }

  async searchMemories(searchParams) {
    const { embedding, type, tags, limit } = searchParams;
    await this.ensureInitialized();

    try {
      const { sqlQuery, queryParams } = this.buildSearchQuery({ embedding, type, tags, limit });
      const result = await this.pool.query(sqlQuery, queryParams);
      return result.rows;
    } catch (error) {
      this.logger.error('Failed to search memories', { error: error.message });
      throw new DatabaseError('Failed to search memories', error);
    }
  }

  buildSearchQuery(params) {
    const { embedding, type, tags, limit } = params;
    let sqlQuery = `
      SELECT id, type, tags, confidence, created_at, updated_at,
            1 - (embedding <#> $1::vector) as similarity
      FROM memories
      WHERE 1=1
    `;

    const queryParams = [`[${embedding.join(',')}]`];
    let paramCount = 1;

    if (type) {
      paramCount++;
      sqlQuery += ` AND type = $${paramCount}`;
      queryParams.push(type);
    }

    if (tags && tags.length > 0) {
      paramCount++;
      sqlQuery += ` AND tags && $${paramCount}::text[]`;
      queryParams.push(tags);
    }

    paramCount++;
    sqlQuery += ` ORDER BY similarity DESC LIMIT $${paramCount}`;
    queryParams.push(limit);

    return { sqlQuery, queryParams };
  }

  async listMemories(type, tags) {
    await this.ensureInitialized();

    try {
      let sqlQuery = `
        SELECT id, type, tags, confidence, created_at, updated_at
        FROM memories
        WHERE 1=1
      `;

      const queryParams = [];
      let paramCount = 0;

      if (type) {
        paramCount++;
        sqlQuery += ` AND type = $${paramCount}`;
        queryParams.push(type);
      }

      if (tags && tags.length > 0) {
        paramCount++;
        sqlQuery += ` AND tags && $${paramCount}::text[]`;
        queryParams.push(tags);
      }

      sqlQuery += ' ORDER BY created_at DESC';

      const result = await this.pool.query(sqlQuery, queryParams);
      return result.rows;
    } catch (error) {
      this.logger.error('Failed to list memories', { error: error.message });
      throw new DatabaseError('Failed to list memories', error);
    }
  }

  async upsertMemory(memoryData) {
    const { type, content, source, embedding, tags, confidence, contentHash } = memoryData;
    await this.ensureInitialized();
    const sql = `
      INSERT INTO memories (type, content, source, embedding, tags, confidence, content_hash)
      VALUES ($1, $2::jsonb, $3, $4::vector, $5, $6, $7)
      ON CONFLICT (content_hash) DO UPDATE
        SET tags = (SELECT ARRAY(SELECT DISTINCT UNNEST(memories.tags || EXCLUDED.tags))),
            confidence = GREATEST(memories.confidence, EXCLUDED.confidence),
            updated_at = NOW()
      RETURNING id, type, content, source, tags, confidence, created_at, updated_at
    `;
    const params = [
      type,
      JSON.stringify(content),
      source,
      `[${embedding.join(',')}]`,
      tags,
      confidence,
      contentHash,
    ];
    const res = await this.pool.query(sql, params);
    return res.rows[0];
  }

  async getMemoryById(id) {
    await this.ensureInitialized();
    const res = await this.pool.query(
      `SELECT id, type, content, source, tags, confidence, created_at, updated_at
        FROM memories WHERE id = $1`,
      [id]
    );
    return res.rows[0] ?? null;
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.isInitialized = false;
      this.logger.info('Database connection closed');
    }
  }
}
