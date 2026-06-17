-- P1-1: persistent active-call state
-- Migration 003 — active_sessions table
-- Postgres syntax. Run manually via executeSql in code_execution.
-- drizzle-kit generate is broken in this repo — do NOT attempt to regenerate.

CREATE TABLE IF NOT EXISTS active_sessions (
  session_id          TEXT PRIMARY KEY,
  device_id           TEXT NOT NULL,
  connection_generation INTEGER NOT NULL DEFAULT 0,
  state               TEXT NOT NULL,
  current_turn_id     TEXT,
  current_response_id TEXT,
  call_start_time     TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_active_sessions_state
  ON active_sessions (state);

CREATE INDEX IF NOT EXISTS idx_active_sessions_device_id
  ON active_sessions (device_id);
