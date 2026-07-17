PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  current_objective TEXT,
  active_topic TEXT,
  latest_intent TEXT,
  unresolved_question TEXT,
  correction_target_turn_id TEXT,
  pending_action_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  conversation_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  current_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  location TEXT NOT NULL,
  uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_turn_id TEXT,
  parent_version_id TEXT,
  UNIQUE(artifact_id, version),
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
  FOREIGN KEY(created_by_turn_id) REFERENCES turns(id) ON DELETE SET NULL,
  FOREIGN KEY(parent_version_id) REFERENCES artifact_versions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS turn_artifacts (
  turn_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY(turn_id, artifact_id),
  FOREIGN KEY(turn_id) REFERENCES turns(id) ON DELETE CASCADE,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_index (
  uri TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  modified_at TEXT,
  indexed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_conversation_created ON turns(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_name ON artifacts(name);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifact_id, version DESC);
