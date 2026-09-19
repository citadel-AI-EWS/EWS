-- LM Studio / llmster state per managed node.
-- The node reports this state over the existing signed Ed25519 channel.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS node_ai_state (
  node_id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL DEFAULT 'lmstudio',
  installed INTEGER NOT NULL DEFAULT 0 CHECK (installed IN (0,1)),
  selected_model TEXT,
  loaded_model TEXT,
  server_running INTEGER NOT NULL DEFAULT 0 CHECK (server_running IN (0,1)),
  last_action TEXT,
  progress_phase TEXT,
  progress_current INTEGER,
  progress_total INTEGER,
  progress_bytes INTEGER,
  progress_total_bytes INTEGER,
  progress_detail TEXT,
  download_job_id TEXT,
  query_id TEXT,
  query_mode TEXT,
  query_status TEXT,
  query_prompt TEXT,
  query_answer TEXT,
  load_config_json TEXT,
  live_checked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_node_ai_state_updated
  ON node_ai_state(updated_at DESC);
