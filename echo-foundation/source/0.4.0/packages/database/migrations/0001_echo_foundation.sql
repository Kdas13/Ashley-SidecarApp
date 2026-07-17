CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE risk_level AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL');
CREATE TYPE pipeline_state AS ENUM ('DRAFT','AWAITING_ALPHA','ENGINE_ONE','SPEC_FROZEN','BUILDING','ENGINE_TWO','AWAITING_OMEGA','APPROVED','REJECTED','FAILED','ROLLED_BACK');
CREATE TYPE approval_kind AS ENUM ('ALPHA','OMEGA');
CREATE TYPE approval_decision AS ENUM ('APPROVED','REJECTED');
CREATE TYPE memory_state AS ENUM ('ACTIVE','PASSIVE','SUPERSEDED','DISPUTED','QUARANTINED');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  display_name text NOT NULL,
  is_final_authority boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL,
  trust_state text NOT NULL DEFAULT 'PENDING',
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orchestration_tasks (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES projects(id),
  title text NOT NULL,
  original_idea text NOT NULL,
  risk risk_level NOT NULL,
  state pipeline_state NOT NULL,
  requested_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_cost_pence integer NOT NULL DEFAULT 0 CHECK (estimated_cost_pence >= 0),
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE approval_events (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES orchestration_tasks(id) ON DELETE CASCADE,
  kind approval_kind NOT NULL,
  decision approval_decision NOT NULL,
  approved_by uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL,
  UNIQUE(task_id, kind)
);

CREATE TABLE pipeline_stage_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES orchestration_tasks(id) ON DELETE CASCADE,
  engine smallint NOT NULL CHECK (engine IN (1,2)),
  stage text NOT NULL,
  status text NOT NULL,
  worker_role text,
  input_hash text,
  output_hash text,
  findings jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE(task_id, engine, stage)
);

CREATE TABLE memory_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  archive_sha256 text NOT NULL,
  source_system text NOT NULL,
  expected_count integer NOT NULL,
  valid_count integer NOT NULL DEFAULT 0,
  quarantined_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'VALIDATED',
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id),
  import_batch_id uuid REFERENCES memory_import_batches(id),
  original_id text,
  source_system text NOT NULL,
  source_version text,
  source_file text,
  original_record_index integer,
  lineage_type text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  thread_id text,
  thread_name text,
  category text,
  importance smallint CHECK (importance BETWEEN 0 AND 10),
  confidence real CHECK (confidence BETWEEN 0 AND 1),
  state memory_state NOT NULL DEFAULT 'ACTIVE',
  first_mentioned timestamptz,
  source_timestamp timestamptz,
  transformation_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  original_raw_record jsonb NOT NULL,
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_thread_idx ON memories(thread_id);
CREATE INDEX memories_content_hash_idx ON memories(content_hash);
CREATE INDEX memories_state_idx ON memories(state);
CREATE INDEX memories_embedding_hnsw ON memories USING hnsw (embedding vector_cosine_ops);

CREATE TABLE memory_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id uuid NOT NULL REFERENCES memory_import_batches(id) ON DELETE CASCADE,
  source_file text,
  original_record_index integer,
  reasons jsonb NOT NULL,
  raw_record jsonb NOT NULL,
  review_status text NOT NULL DEFAULT 'PENDING',
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_packets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  packet_type text NOT NULL,
  title text NOT NULL,
  body jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE open_loops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  owner text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  priority smallint NOT NULL DEFAULT 5,
  due_at timestamptz,
  source_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE improvement_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin text NOT NULL,
  evidence jsonb NOT NULL,
  problem text NOT NULL,
  proposed_change text NOT NULL,
  impact jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED',
  orchestration_task_id uuid REFERENCES orchestration_tasks(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE decision_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  task_id uuid REFERENCES orchestration_tasks(id),
  decision text NOT NULL,
  reason text NOT NULL,
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE queue_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queue_jobs_claim_idx ON queue_jobs(status, available_at, created_at);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id text,
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id text,
  payload jsonb NOT NULL,
  previous_hash text,
  event_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
