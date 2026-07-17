-- Echo Foundation 0.4: resumable full archive staging and passive-only retrieval.
-- This migration does not promote inherited records into the live memories table.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE memory_import_batches
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS staging_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS verified_stageable_count integer,
  ADD COLUMN IF NOT EXISTS verified_quarantine_count integer;

ALTER TABLE memory_import_staging
  ADD COLUMN IF NOT EXISTS search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(thread_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS memory_import_staging_search_document_idx
  ON memory_import_staging USING gin(search_document);
CREATE INDEX IF NOT EXISTS memory_import_staging_content_trgm_idx
  ON memory_import_staging USING gin(content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS memory_import_staging_owner_state_idx
  ON memory_import_staging(owner_user_id, state, import_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS memory_quarantine_batch_source_index_unique
  ON memory_quarantine(import_batch_id, coalesce(source_file, ''), coalesce(original_record_index, -1));

CREATE TABLE IF NOT EXISTS passive_memory_retrieval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  query_hash text NOT NULL,
  query_length integer NOT NULL CHECK (query_length >= 0),
  requested_limit integer NOT NULL CHECK (requested_limit BETWEEN 1 AND 50),
  returned_count integer NOT NULL CHECK (returned_count >= 0),
  batch_filter uuid REFERENCES memory_import_batches(id) ON DELETE SET NULL,
  thread_filter text,
  live_memory_rows_read integer NOT NULL DEFAULT 0 CHECK (live_memory_rows_read = 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS passive_memory_retrieval_events_owner_created_idx
  ON passive_memory_retrieval_events(owner_user_id, created_at DESC);
