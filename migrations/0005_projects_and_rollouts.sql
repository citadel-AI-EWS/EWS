-- Project intake, Hub planning, and scalable agent rollout metadata.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent_rollouts (
  rollout_id TEXT PRIMARY KEY,
  target_version TEXT NOT NULL,
  release_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_rollouts_one_active
  ON agent_rollouts(status)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS architect_projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  task_text TEXT NOT NULL,
  task_sha256 TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  architect_approved INTEGER NOT NULL DEFAULT 0 CHECK (architect_approved IN (0,1)),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','running','completed','blocked','cancelled')),
  worker_count INTEGER NOT NULL DEFAULT 0 CHECK (worker_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_architect_projects_hash_status
  ON architect_projects(task_sha256, status, created_at DESC);

CREATE TABLE IF NOT EXISTS project_work_items (
  work_item_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
  node_id TEXT,
  task_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','assigned','running','completed','failed','cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES architect_projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_project_work_items_project_sequence
  ON project_work_items(project_id, sequence_no);

CREATE INDEX IF NOT EXISTS idx_project_work_items_node_status
  ON project_work_items(node_id, status, created_at);
