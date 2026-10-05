-- Smart canary-gated agent rollout state.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent_rollout_policy (
  rollout_id TEXT PRIMARY KEY,
  canary_node_id TEXT,
  phase TEXT NOT NULL DEFAULT 'canary'
    CHECK (phase IN ('canary','fleet','paused','completed')),
  max_parallel INTEGER NOT NULL DEFAULT 3 CHECK (max_parallel BETWEEN 1 AND 20),
  max_failures INTEGER NOT NULL DEFAULT 2 CHECK (max_failures BETWEEN 1 AND 20),
  pause_reason TEXT,
  canary_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rollout_id) REFERENCES agent_rollouts(rollout_id) ON DELETE CASCADE,
  FOREIGN KEY (canary_node_id) REFERENCES nodes(node_id) ON DELETE SET NULL
);
