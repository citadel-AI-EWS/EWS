import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const index = fs.readFileSync("src/index.js", "utf8");

const materializeStart = index.indexOf("async function materializeProjectWorkForNode");
const materializeEnd = index.indexOf("function projectTextPreflight", materializeStart);
assert.ok(materializeStart >= 0 && materializeEnd > materializeStart, "materializeProjectWorkForNode missing");
const materialize = index.slice(materializeStart, materializeEnd);

// Explicit N is a target/cap, not an all-or-nothing readiness barrier.
// If 4 hosts are ready for target=10, those 4 must be able to start now.
assert.doesNotMatch(
  materialize,
  /readyDistinct\s*<\s*scheduling\.desired_workers/,
  "explicit fanout must not wait for every requested host before the first claim"
);

const claimMatch = materialize.match(
  /env\.DB\.prepare\(\`\n\s*(UPDATE project_work_items[\s\S]*?JOIN nodes AS same_node[\s\S]*?)\n\s*\`\)\.bind\(\n\s*nodeId,\n\s*work\.work_item_id,\n\s*enforceDistinctHost/
);
assert.ok(claimMatch, "production explicit-fanout claim SQL not found");
const claimSql = claimMatch[1].replace(/^ {8}/gm, "");

assert.match(claimSql, /same_host\.status IN \('assigned','running','completed'\)/);
assert.match(claimSql, /lower\(trim\(same_node\.hostname\)\)/);
assert.match(claimSql, /COUNT\(DISTINCT/);

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE nodes (
    node_id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL
  );
  CREATE TABLE project_work_items (
    work_item_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    node_id TEXT,
    status TEXT NOT NULL,
    updated_at TEXT
  );

  INSERT INTO nodes VALUES
    ('nodeA1', 'HOST-ALPHA'),
    ('nodeA2', 'host-alpha'),
    ('nodeB', 'host-beta'),
    ('nodeC', 'host-gamma'),
    ('nodeD', 'host-delta');

  INSERT INTO project_work_items(work_item_id, project_id, node_id, status) VALUES
    ('w1', 'p1', NULL, 'planned'),
    ('w2', 'p1', NULL, 'planned'),
    ('w3', 'p1', NULL, 'planned'),
    ('w4', 'p1', NULL, 'planned');
`);

const claim = db.prepare(claimSql);
const hostKey = (hostname, nodeId) => hostname.trim().toLowerCase() || nodeId;

// Partial start: target=10 must not require ten currently-ready hosts.
const first = claim.run("nodeA1", "w1", 1, hostKey("HOST-ALPHA", "nodeA1"), 10);
assert.equal(Number(first.changes), 1, "first ready host must start immediately for target=10");

// A second enrollment for the same physical hostname must not count as another host.
const duplicatePhysicalHost = claim.run("nodeA2", "w2", 1, hostKey("host-alpha", "nodeA2"), 10);
assert.equal(Number(duplicatePhysicalHost.changes), 0, "duplicate hostname must not consume a second explicit fanout slot");

// A genuinely different host may take the next queued work item.
const secondHost = claim.run("nodeB", "w2", 1, hostKey("host-beta", "nodeB"), 10);
assert.equal(Number(secondHost.changes), 1);

// Same node cannot win a second explicit item concurrently.
const duplicateNode = claim.run("nodeB", "w3", 1, hostKey("host-beta", "nodeB"), 10);
assert.equal(Number(duplicateNode.changes), 0);

// Completed work still represents a physical host already used by this explicit run.
db.prepare("UPDATE project_work_items SET status='completed' WHERE work_item_id='w1'").run();
const duplicateAfterCompletion = claim.run("nodeA2", "w3", 1, hostKey("host-alpha", "nodeA2"), 10);
assert.equal(Number(duplicateAfterCompletion.changes), 0);

// The CAS itself owns the global desired-host cap.
const overCap = claim.run("nodeC", "w3", 1, hostKey("host-gamma", "nodeC"), 2);
assert.equal(Number(overCap.changes), 0, "explicit fanout must not exceed desired distinct physical hosts");

// Auto scheduling intentionally does not enforce the explicit distinct-host cap.
const autoClaim = claim.run("nodeA2", "w3", 0, hostKey("host-alpha", "nodeA2"), 50);
assert.equal(Number(autoClaim.changes), 1, "auto scheduling semantics must remain unchanged");

console.log("FLOW A explicit fanout race guards: PASS");
