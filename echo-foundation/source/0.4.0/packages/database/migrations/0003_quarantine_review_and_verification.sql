-- Echo Foundation 0.3: human quarantine review, immutable review actions,
-- and database verification metadata. Nothing in this migration promotes
-- inherited memory into Echo's live recall layer.

ALTER TABLE memory_quarantine
  ADD COLUMN IF NOT EXISTS decision_note text,
  ADD COLUMN IF NOT EXISTS replacement_content text,
  ADD COLUMN IF NOT EXISTS replacement_content_hash text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS memory_quarantine_review_queue_idx
  ON memory_quarantine(import_batch_id, review_status, created_at, id);

CREATE TABLE IF NOT EXISTS memory_quarantine_review_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quarantine_id uuid NOT NULL REFERENCES memory_quarantine(id) ON DELETE CASCADE,
  import_batch_id uuid NOT NULL REFERENCES memory_import_batches(id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('APPROVE_AS_PASSIVE','REPLACE_AND_APPROVE','REJECT')),
  reason text NOT NULL,
  previous_status text NOT NULL,
  new_status text NOT NULL,
  replacement_content text,
  replacement_content_hash text,
  action_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_quarantine_review_actions_batch_idx
  ON memory_quarantine_review_actions(import_batch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS database_verification_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_version text NOT NULL,
  database_provider text NOT NULL,
  postgres_version text NOT NULL,
  vector_extension_version text,
  migration_names jsonb NOT NULL,
  verification_results jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
