import assert from "node:assert/strict";
import fs from "node:fs";
import { persistWakePeerCommand, rolloutCommandOutcome } from "../src/index.js";

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
assert.match(index, /Number\(rolloutPolicy\.max_parallel \|\| 3\)/);
assert.match(index, /SELECT COUNT\(\*\) FROM commands c JOIN nodes n/);
assert.match(index, /rollout_no_live_canary/);
assert.match(index, /wake_relay_busy/);
assert.match(index, /wake_relay_unavailable/);

const now = Date.parse("2026-10-06T12:00:00Z");
const oldNode = { status: "online", agent_version: "0.3.24", last_seen_at: "2026-10-06T11:59:00Z" };
const newNode = { ...oldNode, agent_version: "0.3.40" };
const command = { status: "completed", created_at: "2026-10-06T11:55:00Z", completed_at: "2026-10-06T11:58:00Z" };
assert.equal(rolloutCommandOutcome(command, oldNode, "0.3.40", now), "pending");
assert.equal(rolloutCommandOutcome(command, newNode, "0.3.40", now), "verified");
assert.equal(rolloutCommandOutcome(command, { ...newNode, last_seen_at: "2026-10-06T11:57:00Z" }, "0.3.40", now), "pending");
assert.equal(rolloutCommandOutcome(command, { ...newNode, status: "offline" }, "0.3.40", now), "pending");
assert.equal(rolloutCommandOutcome(command, newNode, "0.3.40", now + 6 * 60_000), "failed");
assert.equal(rolloutCommandOutcome({ ...command, status: "failed" }, newNode, "0.3.40", now), "failed");
assert.equal(rolloutCommandOutcome(command, oldNode, "0.3.40", now + 5 * 60_000), "failed");

const wakeWrites = [];
const wakeArgs = {
  commandId: "command_wake", relayNodeId: "node_relay", payloadJson: "{}",
  signature: "signed", createdAt: "2026-10-06T12:00:00Z", actorId: "architect",
  targetNodeId: "node_target", auditDetails: { batch: true }
};
const wakeDb = (insertError = null) => ({
  prepare(sql) {
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.includes("INSERT INTO commands")) {
              if (insertError) throw insertError;
              wakeWrites.push(args);
            } else if (sql.includes("INSERT INTO audit_events")) {
              throw Error("audit temporarily unavailable");
            }
          },
          async first() { return null; }
        };
      }
    };
  }
});
const priorLog = console.error;
try {
  console.error = () => {};
  await persistWakePeerCommand({ DB: wakeDb() }, wakeArgs);
  assert.equal(wakeWrites.length, 1, "queued Wake must survive an audit write failure");
  await assert.rejects(
    persistWakePeerCommand({ DB: wakeDb(Error("D1 write failed")) }, wakeArgs),
    (error) => error.code === "wake_queue_failed"
  );
} finally {
  console.error = priorLog;
}
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
