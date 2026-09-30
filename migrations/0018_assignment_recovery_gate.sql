-- Bound stale-assignment recovery so node polling cannot turn the reaper into
-- a fleet-wide D1 hot scan. The single row is claimed at most once per minute.
CREATE TABLE IF NOT EXISTS project_assignment_recovery_gate (
  gate_id INTEGER PRIMARY KEY CHECK (gate_id = 1),
  next_run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO project_assignment_recovery_gate (gate_id, next_run_at)
VALUES (1, CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS idx_assignments_status_assigned_at
  ON assignments(status, assigned_at);

CREATE INDEX IF NOT EXISTS idx_assignments_status_started_at
  ON assignments(status, started_at);
