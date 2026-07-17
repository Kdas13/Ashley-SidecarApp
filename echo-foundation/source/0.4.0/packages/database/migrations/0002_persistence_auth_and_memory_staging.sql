-- Echo Foundation 0.2: persistent orchestration, trusted-device sessions,
-- and a non-live staging area for inherited Ashley memories.

CREATE UNIQUE INDEX IF NOT EXISTS users_single_final_authority
  ON users((is_final_authority))
  WHERE is_final_authority = true;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS device_fingerprint text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS devices_user_fingerprint_unique
  ON devices(user_id, device_fingerprint)
  WHERE device_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS device_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_sessions_active_idx
  ON device_sessions(token_hash, expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE orchestration_tasks
  ADD COLUMN IF NOT EXISTS task_snapshot jsonb;
UPDATE orchestration_tasks
  SET task_snapshot = jsonb_build_object(
    'id', id,
    'input', jsonb_build_object(
      'title', title,
      'originalIdea', original_idea,
      'projectId', coalesce(project_id::text, 'echo'),
      'requestedPermissions', requested_permissions,
      'estimatedCostPence', estimated_cost_pence,
      'affectsProtectedIdentity', false,
      'affectsMemoryGovernance', false,
      'affectsProduction', false,
      'destructive', false
    ),
    'riskLevel', risk,
    'state', state,
    'engineOneCompleted', '[]'::jsonb,
    'engineTwoCompleted', '[]'::jsonb,
    'approvals', '[]'::jsonb,
    'blockers', blockers,
    'createdAt', created_at,
    'updatedAt', updated_at,
    'version', version
  )
  WHERE task_snapshot IS NULL;
ALTER TABLE orchestration_tasks ALTER COLUMN task_snapshot SET NOT NULL;
CREATE INDEX IF NOT EXISTS orchestration_tasks_state_updated_idx
  ON orchestration_tasks(state, updated_at DESC);

ALTER TABLE approval_events
  ADD COLUMN IF NOT EXISTS approved_by_label text;

ALTER TABLE memory_import_batches
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS orchestration_task_id uuid REFERENCES orchestration_tasks(id),
  ADD COLUMN IF NOT EXISTS source_filename text,
  ADD COLUMN IF NOT EXISTS archive_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS manifest jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS memory_import_staging (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id uuid NOT NULL REFERENCES memory_import_batches(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_id text,
  source_system text NOT NULL,
  source_version text,
  source_file text NOT NULL,
  original_record_index integer NOT NULL,
  lineage_type text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  thread_id text,
  thread_name text,
  category text,
  tag text,
  importance smallint CHECK (importance BETWEEN 0 AND 10),
  state memory_state NOT NULL DEFAULT 'PASSIVE',
  first_mentioned timestamptz,
  source_timestamp timestamptz,
  transformation_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  original_raw_record jsonb NOT NULL,
  review_status text NOT NULL DEFAULT 'STAGED',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_batch_id, source_file, original_record_index)
);
CREATE INDEX IF NOT EXISTS memory_import_staging_batch_idx
  ON memory_import_staging(import_batch_id, review_status);
CREATE INDEX IF NOT EXISTS memory_import_staging_content_hash_idx
  ON memory_import_staging(content_hash);

CREATE INDEX IF NOT EXISTS memory_quarantine_batch_idx
  ON memory_quarantine(import_batch_id, review_status);

CREATE TABLE IF NOT EXISTS auth_security_events (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  device_id uuid REFERENCES devices(id),
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_import_batches_owner_archive_task_unique
  ON memory_import_batches(owner_user_id, archive_sha256, orchestration_task_id)
  WHERE status IN ('STAGED', 'PROMOTED');
