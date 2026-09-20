CREATE TABLE IF NOT EXISTS node_request_nonces (
  node_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (node_id, request_id),
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_node_request_nonces_received
ON node_request_nonces(received_at);
