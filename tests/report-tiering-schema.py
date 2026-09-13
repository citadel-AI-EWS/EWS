import sqlite3
from pathlib import Path


connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.execute("CREATE TABLE agent_reports (report_id TEXT PRIMARY KEY)")
connection.executescript(
    Path("migrations/0004_report_tiering.sql").read_text(encoding="utf-8")
)
connection.executescript(
    Path("migrations/0005_google_drive_report_storage.sql").read_text(encoding="utf-8")
)

connection.execute("INSERT INTO agent_reports(report_id) VALUES ('report_schema_test')")
connection.execute(
    """
    INSERT INTO report_objects(
      report_id, storage_provider, object_key, body_sha256, body_size_bytes, state
    ) VALUES ('report_schema_test', 'gdrive', 'drive-file-test', 'abc', 3, 'active')
    """
)
connection.execute(
    """
    INSERT INTO report_storage_audit(
      storage_event_id, report_id, action, object_key, details_json
    ) VALUES ('event_schema_test', 'report_schema_test', 'tier.migrated',
      'reports/test.json', '{}')
    """
)

for statement in (
    "UPDATE report_storage_audit SET action = 'changed' WHERE storage_event_id = 'event_schema_test'",
    "DELETE FROM report_storage_audit WHERE storage_event_id = 'event_schema_test'",
):
    try:
        connection.execute(statement)
    except sqlite3.IntegrityError as error:
        assert "append_only" in str(error)
    else:
        raise AssertionError("storage audit accepted a forbidden mutation")

connection.execute("DELETE FROM agent_reports WHERE report_id = 'report_schema_test'")
assert connection.execute("SELECT COUNT(*) FROM report_objects").fetchone()[0] == 0
assert connection.execute("SELECT COUNT(*) FROM report_storage_audit").fetchone()[0] == 1

print("Append-only report storage audit schema: OK")
