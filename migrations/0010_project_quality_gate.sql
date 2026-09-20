CREATE TABLE IF NOT EXISTS project_quality_gates (
  project_id TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('processing','completed','failed')),
  provider TEXT NOT NULL DEFAULT 'openrouter',
  requested_model TEXT,
  resolved_model TEXT,
  fusion_preset TEXT,
  final_text TEXT,
  error_code TEXT,
  claim_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES architect_projects(project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_quality_gates_status
ON project_quality_gates(status, updated_at);
