CREATE TABLE IF NOT EXISTS node_report_outbox (
  batch_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, node_name TEXT,
  report_json TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', drive_file_id TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
  created_at TEXT NOT NULL, delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_node_report_pending ON node_report_outbox(state, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_node_report_node ON node_report_outbox(node_id, state);
