-- Baseline D1 schema for a clean CITADEL/EWS database.
-- Existing deployed databases already contain these core tables, so every
-- statement is idempotent. This file intentionally describes the schema before
-- 0001_report_storage.sql adds legacy report columns to results.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL,
  os_name TEXT NOT NULL,
  os_version TEXT,
  architecture TEXT,
  agent_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'online'
    CHECK (status IN ('online', 'offline', 'paused', 'revoked')),
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  cpu_percent REAL,
  memory_percent REAL,
  enrolled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS missions (
  mission_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  role_name TEXT NOT NULL,
  mission_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'assigned',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS assignments (
  assignment_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned',
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS results (
  result_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL UNIQUE,
  node_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  summary TEXT,
  artifact_key TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assignment_id) REFERENCES assignments(assignment_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nodes_last_seen
  ON nodes(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_missions_created
  ON missions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignments_node_status
  ON assignments(node_id, status, assigned_at);
CREATE INDEX IF NOT EXISTS idx_assignments_mission
  ON assignments(mission_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_node_created
  ON results(node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commands_node_status_created
  ON commands(node_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_created
  ON audit_events(event_id DESC);
