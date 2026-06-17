-- P1-2: End-of-call summarisation
-- Migration 004 — call_summaries, call_decisions, summarisation_jobs
-- PostgreSQL. Run manually via executeSql.
-- drizzle-kit generate is broken in this repo — do NOT attempt to regenerate.

-- TABLE: call_summaries
CREATE TABLE IF NOT EXISTS call_summaries (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id        TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'pending_review'
                      CHECK (status IN ('committed', 'pending_review', 'superseded')),
  topic             TEXT,
  tone              TEXT,
  open_items        JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary_text      TEXT NOT NULL,
  confidence_score  INTEGER NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 100),
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  committed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_summaries_session
  ON call_summaries (session_id);

CREATE INDEX IF NOT EXISTS idx_call_summaries_status
  ON call_summaries (status);

-- TABLE: call_decisions
CREATE TABLE IF NOT EXISTS call_decisions (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id     TEXT NOT NULL,
  summary_id     TEXT NOT NULL REFERENCES call_summaries(id) ON DELETE CASCADE,
  turn_id        TEXT NOT NULL,
  decision_type  TEXT NOT NULL
                   CHECK (decision_type IN ('action', 'commitment', 'preference', 'question')),
  description    TEXT NOT NULL,
  resolved       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_decisions_session
  ON call_decisions (session_id);

-- TABLE: summarisation_jobs (recovery + idempotency queue)
CREATE TABLE IF NOT EXISTS summarisation_jobs (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_summarisation_jobs_session
  ON summarisation_jobs (session_id);
