-- Initialize database: extensions, schema, and indexes

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Drops existing table for a clean first initialization
DROP TABLE IF EXISTS memories;

-- Create memories table
CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,
    content JSONB NOT NULL,
    source TEXT NOT NULL,
    embedding vector(384) NOT NULL,
    tags TEXT[] DEFAULT '{}',
    confidence DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Vector similarity index
CREATE INDEX IF NOT EXISTS memories_embedding_ivfflat 
ON memories USING ivfflat (embedding vector_l2_ops) WITH (lists = 100);

