import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const index = fs.readFileSync("src/index.js", "utf8");
const agent = fs.readFileSync("agent/citadel_node_v1.py", "utf8");
const agentV2 = fs.readFileSync("agent/citadel_node_v2.py", "utf8");
const setupWindows = fs.readFileSync("agent/setup_windows.ps1", "utf8");

assert.match(agent, /VERSION = "0\.3\.21"/);
assert.match(agentV2, /VERSION = "0\.3\.21"/);
assert.match(setupWindows, /\$ReleaseVersion = "0\.3\.21"/);
assert.match(index, /version: "0\.3\.21"/);

assert.match(index, /async function recoverStaleProjectAssignments\(env\)/);
assert.match(index, /project_assignment_recovery_gate/);
assert.match(index, /idx_assignments_status_assigned_at/);
assert.match(index, /idx_assignments_status_started_at/);
const recoveryStart = index.indexOf("async function recoverStaleProjectAssignments");
const recoveryEnd = index.indexOf("function projectExecutionMode", recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, "recovery function bounds missing");
const recoverySource = index.slice(recoveryStart, recoveryEnd);
assert.doesNotMatch(recoverySource, /datetime\(a\.assigned_at\) <=/);
assert.doesNotMatch(recoverySource, /datetime\(n\.last_seen_at\) </);

assert.match(agent, /def _keep_assignment_live\(self, stop_event: threading\.Event\)/);
assert.match(agent, /self\.heartbeat\(timeout_seconds=5\.0\)/);
assert.match(agent, /heartbeat_thread\.join\(timeout=6\.0\)/);
assert.match(agent, /timeout_seconds: float \| None = None/);

function extract(pattern, label) {
  const match = recoverySource.match(pattern);
  assert.ok(match, label);
  return match[1].replace(/^ {6,10}/gm, "");
}

const gateSql = extract(
  /env\.DB\.prepare\(\`\n\s*(UPDATE project_assignment_recovery_gate[\s\S]*?next_run_at <= CURRENT_TIMESTAMP)\n\s*\`\)\.run\(\)/,
  "recovery gate SQL missing"
);
const assignedScanSql = extract(
  /env\.DB\.prepare\(\`\n\s*(SELECT[^\`]*?WHERE a\.status = 'assigned'[^\`]*?LIMIT 50)\n\s*\`\)/,
  "assigned stale scan missing"
);
const runningScanSql = extract(
  /env\.DB\.prepare\(\`\n\s*(SELECT[^\`]*?WHERE a\.status = 'running'[^\`]*?LIMIT 50)\n\s*\`\)/,
  "running stale scan missing"
);

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE project_assignment_recovery_gate (
    gate_id INTEGER PRIMARY KEY CHECK (gate_id = 1),
    next_run_at TEXT NOT NULL
  );
  INSERT INTO project_assignment_recovery_gate VALUES (1, datetime('now', '-1 minute'));

  CREATE TABLE nodes (
    node_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE TABLE assignments (
    assignment_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    status TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE TABLE project_work_items (
    work_item_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    node_id TEXT,
    status TEXT NOT NULL
  );
  CREATE TABLE results (
    result_id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL UNIQUE
  );

  INSERT INTO nodes VALUES
    ('nodeA', 'online', datetime('now')),
    ('nodeB', 'offline', datetime('now', '-30 minutes')),
    ('nodeC', 'online', datetime('now')),
    ('nodeD', 'online', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')),
    ('nodeE', 'online', datetime('now', '-30 minutes'));

  INSERT INTO assignments VALUES
    ('assignment_w1','nodeA','assigned',datetime('now','-20 minutes'),NULL,NULL),
    ('assignment_w2','nodeA','assigned',datetime('now','-2 minutes'),NULL,NULL),
    ('assignment_w3','nodeB','running',datetime('now','-2 hours'),datetime('now','-60 minutes'),NULL),
    ('assignment_w4','nodeC','running',datetime('now','-2 hours'),datetime('now','-60 minutes'),NULL),
    ('assignment_w5','nodeB','assigned',datetime('now','-20 minutes'),NULL,NULL),
    ('assignment_w6','nodeD','running',datetime('now','-2 hours'),datetime('now','-60 minutes'),NULL),
    ('assignment_w7','nodeE','running',datetime('now','-2 hours'),datetime('now','-60 minutes'),NULL);

  INSERT INTO project_work_items VALUES
    ('w1','p1','nodeA','assigned'),
    ('w2','p1','nodeA','assigned'),
    ('w3','p1','nodeB','running'),
    ('w4','p1','nodeC','running'),
    ('w5','p1','nodeB','assigned'),
    ('w6','p1','nodeD','running'),
    ('w7','p1','nodeE','running');

  INSERT INTO results VALUES ('result_w5','assignment_w5');
`);

const firstGate = db.prepare(gateSql).run();
const secondGate = db.prepare(gateSql).run();
assert.equal(Number(firstGate.changes), 1, "first recovery poll must acquire the global gate");
assert.equal(Number(secondGate.changes), 0, "second poll inside one minute must not rescan stale assignments");

const assigned = db.prepare(assignedScanSql).all().map((row) => row.assignment_id);
assert.deepEqual(assigned, ["assignment_w1"], "assigned scan must select only stale, result-less leases");

const nodeLivenessCutoffIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const nodeLivenessCutoffSqlite = nodeLivenessCutoffIso
  .replace("T", " ")
  .replace(/\.\d{3}Z$/, "");
const running = db.prepare(runningScanSql)
  .all(nodeLivenessCutoffIso, nodeLivenessCutoffSqlite)
  .map((row) => row.assignment_id);
assert.deepEqual(
  running,
  ["assignment_w3", "assignment_w6", "assignment_w7"],
  "running scan must require age and lost liveness for both ISO and SQLite heartbeat timestamps"
);

assert.match(recoverySource, /UPDATE assignments[\s\S]*SET status = 'failed'[\s\S]*NOT EXISTS \([\s\S]*results\.assignment_id = assignments\.assignment_id/);
assert.match(
  recoverySource,
  /UPDATE project_work_items[\s\S]*SET node_id = NULL, status = 'planned'[\s\S]*AND EXISTS \([\s\S]*SELECT 1 FROM assignments[\s\S]*AND status = 'failed'/
);
assert.match(index, /UPDATE missions[\s\S]*status = 'assigned'[\s\S]*expires_at = \?/);
assert.match(
  index,
  /UPDATE assignments[\s\S]*SET mission_id = \?[\s\S]*status = 'assigned'[\s\S]*started_at = NULL[\s\S]*completed_at = NULL[\s\S]*WHERE assignment_id = \?[\s\S]*status IN \('failed','assigned'\)/
);
assert.match(index, /UPDATE project_work_items[\s\S]*SET status = 'running'[\s\S]*assignments\.status = 'running'/);

console.log("FLOW A lease recovery + heartbeat guards: PASS");
