import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const index = fs.readFileSync("src/index.js", "utf8");
const agent = fs.readFileSync("agent/citadel_node_v1.py", "utf8");

assert.match(index, /async function recoverStaleProjectAssignments\(env\)/);
assert.match(index, /assigned_accept_lease_expired/);
assert.match(index, /running_node_heartbeat_lost/);
assert.match(index, /datetime\('now', '-10 minutes'\)/);
assert.match(index, /datetime\('now', '-45 minutes'\)/);
assert.match(index, /project\.work\.requeued_stale/);
assert.match(index, /await recoverStaleProjectAssignments\(env\);\s*await materializeProjectWorkForNode\(env, nodeId\);/);

// Requeue must be one transactional batch and must not fail an assignment unless
// the matching work item is still owned by the same node in the same state.
assert.match(index, /const requeue = await env\.DB\.batch\(\[/);
assert.match(index, /AND w\.node_id = \?[\s\S]*AND w\.status = \?/);
assert.match(index, /AND changes\(\) = 1/);

// Deterministic IDs must repair both the mission and assignment after a stale
// lifecycle, rather than silently losing to INSERT OR IGNORE.
assert.match(index, /UPDATE missions[\s\S]*status = 'assigned'[\s\S]*expires_at = \?/);
assert.match(index, /UPDATE assignments[\s\S]*status IN \('failed','assigned'\)[\s\S]*assigned_at = CURRENT_TIMESTAMP[\s\S]*started_at = NULL[\s\S]*completed_at = NULL/);

// Accept must not advance the work item unless the assignment CAS actually
// leaves that exact assignment running.
assert.match(index, /UPDATE project_work_items[\s\S]*SET status = 'running'[\s\S]*EXISTS \([\s\S]*assignments\.status = 'running'/);

// Extract the exact production claim UPDATE and exercise the stale-read
// interleaving deterministically: both callers may have selected planned work
// before either writes, but the CAS itself must enforce distinct-host/fanout.
const claimMatch = index.match(
  /env\.DB\.prepare\(\`\n\s*(UPDATE project_work_items[\s\S]*?)\n\s*\`\)\.bind\(\n\s*nodeId,\n\s*work\.work_item_id,\n\s*enforceDistinctHost/
);
assert.ok(claimMatch, "production project-work claim SQL not found");
const claimSql = claimMatch[1].replace(/^ {8}/gm, "");

assert.match(claimSql, /NOT EXISTS \([\s\S]*same_node\.node_id = \?/);
assert.match(claimSql, /COUNT\(DISTINCT active\.node_id\)/);

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE project_work_items (
    work_item_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    node_id TEXT,
    status TEXT NOT NULL
  );
`);

const claim = db.prepare(claimSql);

// Simulate two materializers for the same node after both observed different
// planned rows. Only one explicit distinct-host claim may win.
db.exec(`
  INSERT INTO project_work_items VALUES ('w1', 'p1', NULL, 'planned');
  INSERT INTO project_work_items VALUES ('w2', 'p1', NULL, 'planned');
`);
const a1 = claim.run("nodeA", "w1", 1, "nodeA", 2);
const a2 = claim.run("nodeA", "w2", 1, "nodeA", 2);
assert.equal(Number(a1.changes), 1, "first nodeA claim should win");
assert.equal(Number(a2.changes), 0, "same node must not claim a second explicit work item");

const b1 = claim.run("nodeB", "w2", 1, "nodeB", 2);
assert.equal(Number(b1.changes), 1, "second distinct node should fill the fanout");
const fanout = db.prepare(`
  SELECT COUNT(*) AS active, COUNT(DISTINCT node_id) AS hosts
  FROM project_work_items
  WHERE project_id = 'p1' AND status IN ('assigned','running')
`).get();
assert.equal(Number(fanout.active), 2);
assert.equal(Number(fanout.hosts), 2);

// Same-work-item CAS remains single-winner.
db.exec("DELETE FROM project_work_items");
db.exec("INSERT INTO project_work_items VALUES ('w3', 'p2', NULL, 'planned')");
const same1 = claim.run("nodeA", "w3", 1, "nodeA", 1);
const same2 = claim.run("nodeB", "w3", 1, "nodeB", 1);
assert.equal(Number(same1.changes), 1);
assert.equal(Number(same2.changes), 0);
assert.deepEqual(
  db.prepare("SELECT node_id, status FROM project_work_items WHERE work_item_id = 'w3'").get(),
  { node_id: "nodeA", status: "assigned" }
);

assert.match(agent, /import threading/);
assert.match(agent, /def _keep_assignment_live\(self, stop_event: threading\.Event\)/);
assert.match(agent, /target=self\._keep_assignment_live/);
assert.match(agent, /heartbeat_stop\.set\(\)/);
assert.match(agent, /heartbeat_thread\.join\(timeout=2\.0\)/);

console.log("FLOW A assignment race/recovery guards: PASS");
