import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync("src/index.js", "utf8");
const operations = fs.readFileSync("operations.html", "utf8");
const architect = fs.readFileSync("architect.html", "utf8");

for (const required of [
  "CREATE TABLE IF NOT EXISTS agent_rollout_policy",
  "async function reconcileSmartRollout",
  "legacy_rollout_requires_restart",
  "canary_heartbeat_timeout",
  "canary_update_timeout",
  "fleet_failure_budget_exceeded",
  "max_parallel",
  "max_failures",
  "architectUpdateRolloutStatus",
  "async function architectWakeAll",
  "/api/v1/architect/wake-all"
]) assert.ok(index.includes(required), "smart rollout/recovery missing: " + required);

assert.match(index, /phase === "canary" && nodeId !== rolloutPolicy\.canary_node_id/);
assert.match(index, /status IN \('pending','accepted'\)/);
assert.match(index, /Number\(inFlight\?\.count \|\| 0\) >= Number\(rolloutPolicy\.max_parallel \|\| 3\)/);
assert.match(operations, /id="wakeAll"/);
assert.match(operations, /async function startSmartUpdateAll/);
assert.match(operations, /api\('\/update-all'/);
assert.match(operations, /async function wakeAllOffline/);
assert.match(operations, /api\('\/wake-all'/);
assert.match(operations, /onclick="startSmartUpdateAll\(\)"/);
assert.match(operations, /onclick="wakeAllOffline\(\)"/);
assert.match(operations, /async function pollSmartRollout/);
assert.match(operations, /smartRolloutTimer=setTimeout\(pollSmartRollout,1500\)/);
assert.match(operations, /pass<3/);
assert.doesNotMatch(operations, /confirm\('Запустить безопасное автообновление/);
assert.doesNotMatch(operations, /confirm\('Попробовать Wake-on-LAN/);
assert.match(architect, /канарейка/);

console.log("Smart canary rollout + bounded wake recovery guards: OK");
