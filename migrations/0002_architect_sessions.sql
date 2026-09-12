-- Versioned, secret-free Architect session checkpoints.
-- The Worker also applies this schema idempotently through the runtime D1 binding.

CREATE TABLE IF NOT EXISTS architect_sessions (
  session_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  snapshot_size_bytes INTEGER NOT NULL CHECK (snapshot_size_bytes >= 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_architect_sessions_status_updated
  ON architect_sessions(status, updated_at DESC);
