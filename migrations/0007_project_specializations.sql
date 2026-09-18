-- Interactive project specialization registry.
-- Stores Hub-recommended roles and Architect-added roles separately from work-item text.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project_specializations (
  project_id TEXT NOT NULL,
  role_name TEXT NOT NULL,
  source TEXT NOT NULL
    CHECK (source IN ('hub_recommended','architect_added')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, role_name),
  FOREIGN KEY (project_id) REFERENCES architect_projects(project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_specializations_project
  ON project_specializations(project_id, created_at);
