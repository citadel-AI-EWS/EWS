PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS architect_access_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('viewer','operator')),
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_architect_access_tokens_enabled
  ON architect_access_tokens(enabled, role, created_at DESC);

CREATE TABLE IF NOT EXISTS enterprise_sites (
  site_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS enterprise_node_groups (
  group_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS enterprise_node_scope (
  node_id TEXT PRIMARY KEY,
  site_id TEXT,
  group_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (site_id) REFERENCES enterprise_sites(site_id) ON DELETE SET NULL,
  FOREIGN KEY (group_id) REFERENCES enterprise_node_groups(group_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_enterprise_node_scope_site
  ON enterprise_node_scope(site_id, node_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_node_scope_group
  ON enterprise_node_scope(group_id, node_id);

CREATE TABLE IF NOT EXISTS enterprise_desired_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  policy_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
