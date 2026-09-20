-- Architect bearer-token rotation and one-time recovery.
-- Only SHA-256 verifiers are stored. Plain tokens/recovery codes are never persisted.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS architect_auth_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  token_hash TEXT NOT NULL,
  bootstrap_mode INTEGER NOT NULL DEFAULT 1 CHECK (bootstrap_mode IN (0,1)),
  recovery_hash TEXT,
  recovery_used INTEGER NOT NULL DEFAULT 1 CHECK (recovery_used IN (0,1)),
  token_rotated_at TEXT,
  recovery_created_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS architect_recovery_attempts (
  actor_hash TEXT NOT NULL,
  window_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_hash, window_key)
);

CREATE INDEX IF NOT EXISTS idx_architect_recovery_attempts_updated
  ON architect_recovery_attempts(updated_at);
