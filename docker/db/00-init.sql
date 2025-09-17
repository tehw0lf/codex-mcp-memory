-- Initialize database: extensions, schema, and indexes
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  content JSONB NOT NULL,
  source TEXT NOT NULL,
  embedding vector(384) NOT NULL,
  tags TEXT [] DEFAULT '{}',
  confidence DOUBLE PRECISION NOT NULL,
  content_hash bytea UNIQUE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Only cosine HNSW index (no IVFFlat)
CREATE INDEX IF NOT EXISTS memories_embed_hnsw ON memories USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS memories_tags_gin ON memories USING gin (tags);

ALTER TABLE
  memories
ADD
  COLUMN IF NOT EXISTS content_text tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(content :: text, '') || ' ' || coalesce(source, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS memories_content_text_idx ON memories USING gin (content_text);
