"""Exercise the deployed legacy schema rebuild with real SQLite constraints."""

from pathlib import Path
import sqlite3


db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
db.executescript("""
CREATE TABLE nodes(node_id TEXT PRIMARY KEY);
INSERT INTO nodes VALUES ('node-1');
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY, node_id TEXT NOT NULL,
  command_type TEXT NOT NULL CHECK (command_type IN ('pause','resume','update','uninstall')),
  payload_json TEXT NOT NULL DEFAULT '{}', signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','completed','failed','expired')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id)
);
CREATE TABLE ssh_console_results (
  command_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, output TEXT NOT NULL,
  exit_code INTEGER NOT NULL CHECK (exit_code BETWEEN 0 AND 255),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (command_id) REFERENCES commands(command_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);
INSERT INTO commands(command_id,node_id,command_type,signature,status)
VALUES ('old-ssh','node-1','update','signature','completed');
INSERT INTO ssh_console_results(command_id,node_id,output,exit_code)
VALUES ('old-ssh','node-1','real stdout',0);
""")

migration = Path("migrations/0028_expand_legacy_commands.sql").read_text()
db.executescript("BEGIN;\n" + migration + "\nCOMMIT;")
db.execute("""INSERT INTO commands(command_id,node_id,command_type,signature,status)
              VALUES ('ai','node-1','hybrid_query','signature','pending')""")
db.execute("UPDATE commands SET status='cancelled' WHERE command_id='ai'")
db.execute("""INSERT INTO commands(command_id,node_id,command_type,signature,status)
              VALUES ('wake','node-1','wake_peer','signature','completed')""")
assert db.execute("SELECT output FROM ssh_console_results").fetchone()[0] == "real stdout"
assert db.execute("SELECT count(*) FROM commands").fetchone()[0] == 3
assert db.execute("PRAGMA foreign_key_check").fetchall() == []
assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
print("Legacy command migration, SSH preservation, AI/Wake inserts, foreign keys: PASS")
