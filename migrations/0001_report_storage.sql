-- Store complete, authenticated agent reports in D1.
-- Existing result rows remain readable; new reports receive all metadata below.

ALTER TABLE results ADD COLUMN report_type TEXT;
ALTER TABLE results ADD COLUMN report_json TEXT;
ALTER TABLE results ADD COLUMN report_sha256 TEXT;
ALTER TABLE results ADD COLUMN report_size_bytes INTEGER;
ALTER TABLE results ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'internal';

CREATE INDEX IF NOT EXISTS idx_results_node_created
  ON results(node_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_results_report_type_created
  ON results(report_type, created_at DESC);
