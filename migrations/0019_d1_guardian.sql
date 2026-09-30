CREATE TABLE IF NOT EXISTS d1_guardian_state (
  guardian_id INTEGER PRIMARY KEY CHECK (guardian_id = 1),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','checking','healthy','repaired','warning','error')),
  next_run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  next_deep_check_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_run_at TEXT,
  last_ok_at TEXT,
  checked_rules INTEGER NOT NULL DEFAULT 0,
  detected_issues INTEGER NOT NULL DEFAULT 0,
  repaired_rows INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO d1_guardian_state (guardian_id) VALUES (1);

CREATE TABLE IF NOT EXISTS d1_guardian_actions (
  action_id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  rows_affected INTEGER NOT NULL DEFAULT 0 CHECK (rows_affected >= 0),
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_d1_guardian_actions_created
ON d1_guardian_actions(created_at DESC, action_id DESC);
