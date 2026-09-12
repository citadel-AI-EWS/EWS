-- Tier complete report bodies out of D1 while keeping report metadata authoritative.
-- The original agent_reports table stays compatible with existing TEST data.
-- Once an R2 copy is verified, agent_reports.report_json is replaced with a
-- small sentinel; the original SHA-256 and size stay in agent_reports.

CREATE TABLE IF NOT EXISTS report_objects (
  report_id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  body_sha256 TEXT NOT NULL,
  body_size_bytes INTEGER NOT NULL CHECK (body_size_bytes >= 0),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'deleted', 'purged')),
  migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delete_requested_at TEXT,
  restored_at TEXT,
  purged_at TEXT,
  FOREIGN KEY (report_id) REFERENCES agent_reports(report_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_report_objects_state_migrated
  ON report_objects(state, migrated_at DESC);

CREATE INDEX IF NOT EXISTS idx_report_objects_delete_requested
  ON report_objects(state, delete_requested_at);

CREATE TABLE IF NOT EXISTS report_storage_audit (
  storage_event_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  action TEXT NOT NULL,
  object_key TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES agent_reports(report_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_report_storage_audit_report_created
  ON report_storage_audit(report_id, created_at DESC);
