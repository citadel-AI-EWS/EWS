-- Production TEST still has the original command_type/status CHECK constraints.
-- Rebuild both tables in one D1 transaction so existing commands and SSH
-- results survive while newer command types (hybrid_query, wake_peer, etc.)
-- become persistable. The deploy job runs this only for that legacy schema.
CREATE TABLE commands_v2 (
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

INSERT INTO commands_v2
  (command_id, node_id, command_type, payload_json, signature, status, created_at, completed_at)
SELECT command_id, node_id, command_type, payload_json, signature, status, created_at, completed_at
FROM commands;

CREATE TABLE ssh_console_results_v2 (
  command_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  output TEXT NOT NULL,
  exit_code INTEGER NOT NULL CHECK (exit_code BETWEEN 0 AND 255),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (command_id) REFERENCES commands_v2(command_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

INSERT INTO ssh_console_results_v2 (command_id, node_id, output, exit_code, created_at)
SELECT command_id, node_id, output, exit_code, created_at FROM ssh_console_results;

DROP TABLE ssh_console_results;
DROP TABLE commands;
ALTER TABLE commands_v2 RENAME TO commands;
ALTER TABLE ssh_console_results_v2 RENAME TO ssh_console_results;

CREATE INDEX idx_commands_node_status ON commands(node_id, status);
CREATE UNIQUE INDEX idx_commands_one_active_per_node ON commands(node_id)
  WHERE status IN ('pending', 'accepted');
CREATE INDEX idx_commands_node_status_created ON commands(node_id, status, created_at);
CREATE INDEX idx_commands_status_created ON commands(status, created_at DESC, command_id DESC);
CREATE INDEX idx_commands_created_time ON commands(datetime(created_at) DESC, command_id DESC);
CREATE INDEX idx_ssh_console_results_node_created
  ON ssh_console_results(node_id, created_at DESC);
