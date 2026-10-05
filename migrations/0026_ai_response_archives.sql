-- Archive every completed direct AI/LM Studio response in Google Drive with
-- minimal D1 metadata for dedupe and lookup.
CREATE TABLE IF NOT EXISTS ai_response_archives (
  query_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  payload_id TEXT NOT NULL UNIQUE,
  drive_file_id TEXT NOT NULL UNIQUE,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (payload_id) REFERENCES payload_objects(payload_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_response_archives_node_created
  ON ai_response_archives(node_id, created_at DESC);
