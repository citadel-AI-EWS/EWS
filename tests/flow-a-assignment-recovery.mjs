import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const index = fs.readFileSync("src/index.js", "utf8");
const agent = fs.readFileSync("agent/citadel_node_v1.py", "utf8");
const agentV2 = fs.readFileSync("agent/citadel_node_v2.py", "utf8");

assert.match(index, /async function recoverStaleProjectAssignments\(env\)/);
assert.match(index, /project_assignment_recovery_gate/);
assert.match(index, /idx_assignments_status_assigned_at/);
assert.match(index, /idx_assignments_status_started_at/);

const recoveryStart = index.indexOf("async function recoverStaleProjectAssignments");
const recoveryEnd = index.indexOf("function projectExecutionMode", recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, "recovery function bounds missing");
const recoverySource = index.slice(recoveryStart, recoveryEnd);

assert.doesNotMatch(recoverySource, /COALESCE\(a\.started_at, a\.assigned_at\)/,
  "running recovery must preserve the status/started_at index path");
assert.match(recoverySource, /a\.started_at IS NOT NULL[\s\S]*a\.started_at <= datetime\('now', '-45 minutes'\)/);
assert.match(recoverySource, /a\.started_at IS NULL[\s\S]*a\.assigned_at <= datetime\('now', '-45 minutes'\)/);
assert.doesNotMatch(recoverySource, /datetime\(a\.assigned_at\) <=/);
assert.doesNotMatch(recoverySource, /datetime\(a\.started_at\) <=/);

const listStart = index.indexOf("async function listAssignments");
const listEnd = index.indexOf("async function acceptAssignment", listStart);
const listSource = index.slice(listStart, listEnd);
assert.ok(listSource.indexOf("recoverStaleProjectAssignments(env)") >= 0);
assert.ok(
  listSource.indexOf("recoverStaleProjectAssignments(env)") <
    listSource.indexOf("materializeProjectWorkForNode(env, nodeId)"),
  "stale recovery must run independently before normal materialization"
);

assert.match(agent, /class ControllerApiError\(RuntimeError\)/);
assert.match(agent, /timeout_seconds: float \| None = None/);
assert.match(agent, /def _keep_assignment_live\(self, stop_event: threading\.Event\)/);
assert.match(agent, /self\.heartbeat\(timeout_seconds=5\.0\)/);
assert.match(agent, /heartbeat_thread\.join\(timeout=6\.0\)/);
assert.match(agent, /error\.status == 409/);
assert.match(agent, /"assignment_not_active"/);
assert.match(agent, /"result_already_exists"/);
assert.match(agentV2, /"assignment_heartbeat_failed"/);

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

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE project_assignment_recovery_gate (
    gate_id INTEGER PRIMARY KEY CHECK (gate_id = 1),
    next_run_at TEXT NOT NULL
  );
  INSERT INTO project_assignment_recovery_gate VALUES (1, datetime('now', '-1 minute'));
  CREATE TABLE assignments (
    assignment_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, status TEXT NOT NULL,
    assigned_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
  );
  CREATE TABLE project_work_items (
    work_item_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, node_id TEXT, status TEXT NOT NULL
  );
  CREATE TABLE results (
    result_id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL UNIQUE
  );
  INSERT INTO assignments VALUES
    ('assignment_w1','nodeA','assigned',datetime('now','-20 minutes'),NULL,NULL),
    ('assignment_w2','nodeA','assigned',datetime('now','-2 minutes'),NULL,NULL),
    ('assignment_w3','nodeA','assigned',datetime('now','-20 minutes'),NULL,NULL);
  INSERT INTO project_work_items VALUES
    ('w1','p1','nodeA','assigned'),
    ('w2','p1','nodeA','assigned'),
    ('w3','p1','nodeA','assigned');
  INSERT INTO results VALUES ('result_w3','assignment_w3');
`);

const firstGate = db.prepare(gateSql).run();
const secondGate = db.prepare(gateSql).run();
assert.equal(Number(firstGate.changes), 1);
assert.equal(Number(secondGate.changes), 0);

const assigned = db.prepare(assignedScanSql).all().map(row => row.assignment_id);
assert.deepEqual(assigned, ["assignment_w1"],
  "only stale result-less assigned leases may be recovered");

console.log("FLOW A stale recovery, heartbeat and terminal-result queue guards: PASS");
