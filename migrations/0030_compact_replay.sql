CREATE TABLE IF NOT EXISTS node_replay_migrations (
  migration_id TEXT PRIMARY KEY,
  not_before INTEGER NOT NULL CHECK (not_before > 0)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS node_error_windows (
  node_id TEXT PRIMARY KEY REFERENCES nodes(node_id) ON DELETE CASCADE,
  windows_json TEXT NOT NULL CHECK (json_valid(windows_json))
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS node_replay_windows (
  node_id TEXT PRIMARY KEY REFERENCES nodes(node_id) ON DELETE CASCADE,
  claims_json TEXT NOT NULL CHECK (json_valid(claims_json))
) WITHOUT ROWID;
