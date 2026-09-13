-- Upgrade the draft R2 report tier to encrypted Google Drive storage.
-- Existing R2 rows retain their provider. New rows are explicitly tagged.

ALTER TABLE report_objects
  ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'r2'
    CHECK (storage_provider IN ('gdrive', 'r2'));

-- Rebuild the audit table without a cascading foreign key. Storage evidence
-- must survive later cleanup of operational report metadata.
CREATE TABLE report_storage_audit_v2 (
  storage_event_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  action TEXT NOT NULL,
  object_key TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO report_storage_audit_v2 (
  storage_event_id, report_id, action, object_key, details_json, created_at
)
SELECT storage_event_id, report_id, action, object_key, details_json, created_at
FROM report_storage_audit;

DROP TABLE report_storage_audit;
ALTER TABLE report_storage_audit_v2 RENAME TO report_storage_audit;

CREATE INDEX idx_report_storage_audit_report_created
  ON report_storage_audit(report_id, created_at DESC);

CREATE TRIGGER report_storage_audit_no_update
BEFORE UPDATE ON report_storage_audit
BEGIN
  SELECT RAISE(ABORT, 'report_storage_audit_is_append_only');
END;

CREATE TRIGGER report_storage_audit_no_delete
BEFORE DELETE ON report_storage_audit
BEGIN
  SELECT RAISE(ABORT, 'report_storage_audit_is_append_only');
END;
