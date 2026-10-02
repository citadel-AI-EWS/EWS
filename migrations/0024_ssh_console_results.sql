-- Bounded on-demand results for the restricted Hub SSH console.
-- Kept separate from the hot commands table so ordinary command polling stays lean.
CREATE TABLE IF NOT EXISTS ssh_console_results (
  command_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  output TEXT NOT NULL,
  exit_code INTEGER NOT NULL CHECK (exit_code BETWEEN 0 AND 255),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (command_id) REFERENCES commands(command_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ssh_console_results_node_created
ON ssh_console_results(node_id, created_at DESC);
