-- CITADEL EWS: minimal D1 index for Google Drive payload storage.
-- Large prompts, report bodies, session snapshots and interactive messages live in Drive.
-- D1 stores identifiers, ownership, integrity metadata and workflow state only.

CREATE TABLE IF NOT EXISTS payload_objects (
  payload_id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  drive_file_id TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payload_objects_owner
  ON payload_objects(owner_type, owner_id, kind, created_at);

CREATE TABLE IF NOT EXISTS interactive_threads (
  thread_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  work_item_id TEXT,
  node_id TEXT,
  role_name TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('ai','python')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES architect_projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_threads_project_work
  ON interactive_threads(project_id, work_item_id)
  WHERE work_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS interactive_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
  actor TEXT NOT NULL CHECK (actor IN ('user','agent','system')),
  payload_id TEXT NOT NULL,
  response_work_item_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES interactive_threads(thread_id) ON DELETE CASCADE,
  FOREIGN KEY (payload_id) REFERENCES payload_objects(payload_id) ON DELETE RESTRICT,
  UNIQUE (thread_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS idx_interactive_messages_thread
  ON interactive_messages(thread_id, sequence_no);
