-- Extend existing node_ai_state rows with live LM Studio / Hybrid progress.
-- Forward-only migration: 0008 remains immutable for already-migrated D1 databases.

PRAGMA foreign_keys = ON;

ALTER TABLE node_ai_state ADD COLUMN progress_phase TEXT;
ALTER TABLE node_ai_state ADD COLUMN progress_current INTEGER;
ALTER TABLE node_ai_state ADD COLUMN progress_total INTEGER;
ALTER TABLE node_ai_state ADD COLUMN progress_bytes INTEGER;
ALTER TABLE node_ai_state ADD COLUMN progress_total_bytes INTEGER;
ALTER TABLE node_ai_state ADD COLUMN progress_detail TEXT;
ALTER TABLE node_ai_state ADD COLUMN download_job_id TEXT;
ALTER TABLE node_ai_state ADD COLUMN query_id TEXT;
ALTER TABLE node_ai_state ADD COLUMN query_mode TEXT;
ALTER TABLE node_ai_state ADD COLUMN query_status TEXT;
ALTER TABLE node_ai_state ADD COLUMN query_prompt TEXT;
ALTER TABLE node_ai_state ADD COLUMN query_answer TEXT;
ALTER TABLE node_ai_state ADD COLUMN load_config_json TEXT;
ALTER TABLE node_ai_state ADD COLUMN live_checked_at TEXT;
