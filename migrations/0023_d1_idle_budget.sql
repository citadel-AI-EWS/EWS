-- Bound historical reads in per-node details and the 50-project list.
-- Hot heartbeat/nonce tables deliberately receive no additional indexes.
CREATE INDEX IF NOT EXISTS idx_commands_node_created_time
  ON commands(node_id, datetime(created_at) DESC, command_id DESC);
CREATE INDEX IF NOT EXISTS idx_node_logs_node_created_time
  ON node_logs(node_id, datetime(created_at) DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_architect_projects_created
  ON architect_projects(created_at DESC);
