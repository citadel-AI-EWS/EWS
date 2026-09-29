-- Auto-enrollment storage required by public Hub node-number lookups.
-- This migration is intentionally idempotent because the existing TEST database
-- may already contain these tables from the legacy runtime bootstrap path.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS node_numbers (
  node_number INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_node_numbers_public_key
  ON node_numbers(public_key);

CREATE TABLE IF NOT EXISTS auto_enrollment_windows (
  window_key TEXT PRIMARY KEY,
  created_count INTEGER NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
