-- Reduce D1 rows-read amplification on hot polling paths.
-- Agents poll assignments repeatedly; materializeProjectWorkForNode filters work by
-- status before project and node preference. The existing indexes are project-first
-- and node-first, so an idle fleet can scan historical work items on every poll.
CREATE INDEX IF NOT EXISTS idx_project_work_items_status_project_created
  ON project_work_items(status, project_id, created_at, sequence_no);

-- Hot fleet reads repeatedly select online/recent nodes. Keep that lookup bounded
-- as node history grows.
CREATE INDEX IF NOT EXISTS idx_nodes_status_last_seen
  ON nodes(status, last_seen_at DESC, node_id);

-- Architect log statistics exclude heartbeat audit events and use a seven-day
-- created_at window. This index avoids scanning old audit history for that view.
CREATE INDEX IF NOT EXISTS idx_audit_events_created_action
  ON audit_events(created_at DESC, action);
