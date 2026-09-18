-- Split durable report bodies into an indexed table without losing reports
-- written by migration 0001. Keep 0001 immutable because Wrangler records applied
-- migration filenames in d1_migrations.

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

INSERT OR IGNORE INTO agent_reports (
  report_id, result_id, assignment_id, mission_id, node_id,
  report_type, report_json, report_sha256, report_size_bytes,
  sensitivity, created_at
)
SELECT
  'report_' || r.result_id,
  r.result_id,
  r.assignment_id,
  a.mission_id,
  r.node_id,
  COALESCE(NULLIF(r.report_type, ''), 'mission_result'),
  r.report_json,
  r.report_sha256,
  r.report_size_bytes,
  COALESCE(NULLIF(r.sensitivity, ''), 'internal'),
  r.created_at
FROM results AS r
JOIN assignments AS a ON a.assignment_id = r.assignment_id
WHERE r.report_json IS NOT NULL
  AND r.report_sha256 IS NOT NULL
  AND r.report_size_bytes IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_reports_created
  ON agent_reports(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_reports_node_created
  ON agent_reports(node_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_reports_mission_created
  ON agent_reports(mission_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_reports_type_created
  ON agent_reports(report_type, created_at DESC);
