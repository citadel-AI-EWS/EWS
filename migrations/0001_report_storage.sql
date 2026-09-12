-- Store complete, authenticated agent reports without changing legacy result rows.
-- The Worker creates this same idempotent schema through its D1 binding so TEST
-- deployment does not require a Cloudflare API token with separate D1 Edit rights.

CREATE TABLE IF NOT EXISTS agent_reports (
  report_id TEXT PRIMARY KEY,
  result_id TEXT NOT NULL UNIQUE,
  assignment_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  report_type TEXT NOT NULL,
  report_json TEXT NOT NULL,
  report_sha256 TEXT NOT NULL,
  report_size_bytes INTEGER NOT NULL CHECK (report_size_bytes >= 0),
  sensitivity TEXT NOT NULL DEFAULT 'internal'
    CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (result_id) REFERENCES results(result_id) ON DELETE CASCADE,
  FOREIGN KEY (assignment_id) REFERENCES assignments(assignment_id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_reports_node_created
  ON agent_reports(node_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_reports_mission_created
  ON agent_reports(mission_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_reports_type_created
  ON agent_reports(report_type, created_at DESC);
