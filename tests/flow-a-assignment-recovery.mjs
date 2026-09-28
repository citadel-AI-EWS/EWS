import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync("src/index.js", "utf8");
const agent = fs.readFileSync("agent/citadel_node_v1.py", "utf8");

assert.match(index, /async function recoverStaleProjectAssignments\(env\)/);
assert.match(index, /assigned_accept_lease_expired/);
assert.match(index, /running_node_heartbeat_lost/);
assert.match(index, /datetime\('now', '-10 minutes'\)/);
assert.match(index, /datetime\('now', '-45 minutes'\)/);
assert.match(index, /project\.work\.requeued_stale/);
assert.match(index, /await recoverStaleProjectAssignments\(env\);\s*await materializeProjectWorkForNode\(env, nodeId\);/);
assert.match(index, /UPDATE assignments[\s\S]*status = 'assigned'[\s\S]*assigned_at = CURRENT_TIMESTAMP[\s\S]*started_at = NULL[\s\S]*completed_at = NULL/);

assert.match(agent, /import threading/);
assert.match(agent, /def _keep_assignment_live\(self, stop_event: threading\.Event\)/);
assert.match(agent, /target=self\._keep_assignment_live/);
assert.match(agent, /heartbeat_stop\.set\(\)/);
assert.match(agent, /heartbeat_thread\.join\(timeout=2\.0\)/);

console.log("FLOW A stale assignment recovery guards: PASS");
