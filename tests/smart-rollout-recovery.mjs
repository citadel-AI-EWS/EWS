import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import {
  chooseSmartRolloutCanary, persistWakePeerCommand,
  reconcileSmartRollout, rolloutCommandOutcome
} from "../src/index.js";

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
assert.equal(rolloutCommandOutcome({ ...command, status: "failed" }, newNode, "0.3.40", now), "verified",
  "newer live heartbeat with target version must override a failed acknowledgement");
assert.equal(rolloutCommandOutcome({ ...command, status: "failed" },
  { ...newNode, last_seen_at: "2026-10-06T11:57:00Z" }, "0.3.40", now), "failed");
assert.equal(rolloutCommandOutcome(command, oldNode, "0.3.40", now + 5 * 60_000), "failed");

const liveCandidates = [{ node_id: "node_a22" }, { node_id: "node_b17" }];
assert.equal(chooseSmartRolloutCanary(liveCandidates, null)?.node_id, "node_a22");
assert.equal(chooseSmartRolloutCanary(liveCandidates, {
  phase: "paused", pause_reason: "canary_command_failed", canary_node_id: "node_a22"
})?.node_id, "node_b17");
assert.equal(chooseSmartRolloutCanary(liveCandidates.slice(0, 1), {
  phase: "paused", pause_reason: "canary_command_failed", canary_node_id: "node_a22"
}), null, "do not silently retry the same failed canary");
assert.match(index, /canary_diagnostic_hint: canaryNeedsLogs \? "agent_logs_required"/);
assert.match(index, /policy.phase === "canary" \|\| canaryPaused/);
assert.match(index, /reused_existing: true/);
assert.match(operations, /SSH → agent-logs/);

// Exercise the actual browser status watcher: one slow request is not a
// terminal rollout failure, and a paused canary remains observable.
const watcherSource = operations.slice(
  operations.indexOf("let smartRolloutTimer=null"),
  operations.indexOf("async function dispatchFleetCommands")
);
assert.ok(watcherSource.includes("async function pollSmartRollout"));
const scheduled = [], notices = [], activity = { hidden: true }, activityText = { textContent: "" };
let statusResponse = null;
const watcher = vm.createContext({
  token: "test", document: { hidden: false },
  api: async () => { if (statusResponse instanceof Error) throw statusResponse; return statusResponse; },
  setTimeout: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; },
  clearTimeout: () => {},
  $: (id) => id === "fleetActivity" ? activity : activityText,
  setFleetActivity: () => { activity.hidden = false; },
  tell: (message) => notices.push(message),
  sessionStorage: { removeItem: () => {} }
});
vm.runInContext(watcherSource, watcher);
statusResponse = Error("signal timed out");
await vm.runInContext("pollSmartRollout()", watcher);
assert.equal(scheduled.at(-1).delay, 5000);
assert.equal(notices.length, 1);
await vm.runInContext("pollSmartRollout()", watcher);
assert.equal(scheduled.at(-1).delay, 10000);
assert.equal(notices.length, 1, "repeat timeout should not flood notifications");
statusResponse = { rollout: {
  rollout_id: "rollout_test", phase: "paused", status: "active",
  pause_reason: "canary_command_failed", registered_nodes: 27,
  nodes_waiting_for_update: 27
} };
await vm.runInContext("pollSmartRollout()", watcher);
assert.equal(scheduled.at(-1).delay, 15000);
assert.equal(notices.length, 2);
await vm.runInContext("pollSmartRollout()", watcher);
assert.equal(notices.length, 2, "unchanged pause reason should be announced once");
statusResponse = { rollout: {
  rollout_id: "rollout_test", phase: "paused", status: "active",
  pause_reason: "fleet_failure_budget_exceeded", registered_nodes: 27,
  nodes_waiting_for_update: 25, max_failures: 2, failed_node_count: 2,
  failed_nodes: [{ hostname: "a18" }, { hostname: "a19" }]
} };
await vm.runInContext("pollSmartRollout()", watcher);
assert.match(notices.at(-1), /2 узла, лимит 2 \(a18, a19\)/);
assert.match(notices.at(-1), /Статус перепроверяется/);
assert.equal(scheduled.at(-1).delay, 15000);

const recent = Date.now();
const stamp = (agoMs) => new Date(recent - agoMs).toISOString();
const pausedPolicy = {
  rollout_id: "rollout_test", canary_node_id: "node_a22",
  phase: "paused", pause_reason: "canary_command_failed",
  max_parallel: 3, max_failures: 2
};
let promoted = false;
const recoveryDb = {
  prepare(sql) {
    return {
      bind() {
        return {
          sql,
          async first() {
            if (sql.includes("FROM agent_rollout_policy")) return pausedPolicy;
            if (sql.includes("FROM nodes WHERE")) return {
              node_id: "node_a22", status: "online", agent_version: "0.3.40",
              last_seen_at: stamp(10_000)
            };
            if (sql.includes("FROM commands")) return {
              command_id: "command_canary", status: "failed",
              created_at: stamp(80_000), completed_at: stamp(20_000)
            };
            throw Error("unexpected query: " + sql);
          }
        };
      }
    };
  },
  async batch(statements) {
    assert.ok(statements.some((item) => item.sql.includes("SET phase = 'fleet'")));
    promoted = true;
    pausedPolicy.phase = "fleet";
    pausedPolicy.pause_reason = null;
    return [];
  }
};
const recovered = await reconcileSmartRollout({ DB: recoveryDb }, {
  rollout_id: "rollout_test", target_version: "0.3.40", created_at: stamp(90_000)
});
assert.equal(promoted, true, "verified heartbeat must unpause the rollout");
assert.equal(recovered.phase, "fleet");

// Run the real D1 SQL against SQLite: repeated failures on one computer must
// not consume two fleet slots, and a paused fleet must recheck live evidence.
async function fleetFixture({ phase = "fleet", nodes, commands }) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE nodes (node_id TEXT PRIMARY KEY, hostname TEXT, status TEXT,
      agent_version TEXT, last_seen_at TEXT);
    CREATE TABLE commands (command_id TEXT PRIMARY KEY, node_id TEXT,
      command_type TEXT, status TEXT, payload_json TEXT, created_at TEXT, completed_at TEXT);
    CREATE TABLE agent_rollout_policy (rollout_id TEXT PRIMARY KEY, canary_node_id TEXT,
      phase TEXT, max_parallel INTEGER, max_failures INTEGER, pause_reason TEXT,
      canary_verified_at TEXT, updated_at TEXT);
    CREATE TABLE audit_events (actor_type TEXT, actor_id TEXT, action TEXT,
      target_type TEXT, target_id TEXT, details_json TEXT);
  `);
  const insertNode = sqlite.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?)");
  for (const n of nodes) insertNode.run(n.id, n.id.replace("node_", ""),
    n.status || "online", n.version || "0.3.24", n.seen || stamp(10_000));
  const insertCommand = sqlite.prepare("INSERT INTO commands VALUES (?, ?, 'update', ?, ?, ?, ?)");
  for (const c of commands) insertCommand.run(c.id, c.node, c.status || "failed",
    JSON.stringify({ version: c.version || "0.3.40" }),
    c.created || stamp(80_000), c.completed || stamp(20_000));
  sqlite.prepare("INSERT INTO agent_rollout_policy VALUES (?, ?, ?, 3, 2, ?, ?, ?)")
    .run("rollout_test", "node_a17", phase,
      phase === "paused" ? "fleet_failure_budget_exceeded" : null, stamp(90_000), stamp(20_000));
  const db = {
    prepare(sql) {
      return { bind(...args) {
        const statement = sqlite.prepare(sql);
        return {
          async first() { return statement.get(...args) || null; },
          async all() { return { results: statement.all(...args) }; },
          async run() { return { meta: { changes: statement.run(...args).changes } }; }
        };
      } };
    },
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); }
  };
  try {
    const policy = await reconcileSmartRollout({ DB: db }, {
      rollout_id: "rollout_test", target_version: "0.3.40", created_at: stamp(120_000)
    });
    return { policy, audits: sqlite.prepare("SELECT action FROM audit_events").all() };
  } finally {
    sqlite.close();
  }
}
const goodCanary = { id: "node_a17", version: "0.3.40" };
const canaryAttempt = { id: "canary", node: "node_a17", status: "completed" };
const oldFailure = { id: "old_failure", node: "node_a18" };
const repeatedFailure = { ...oldFailure, id: "repeat_failure" };
let fleet = await fleetFixture({
  nodes: [goodCanary, { id: "node_a18" }],
  commands: [canaryAttempt, oldFailure, repeatedFailure]
});
assert.equal(fleet.policy.phase, "fleet", "one failed node cannot exhaust a two-node budget");
assert.equal(fleet.policy.failed_node_count, 1);
assert.equal(fleet.policy.failed_nodes[0].command_id, "repeat_failure",
  "same-second attempts must use the later SQLite rowid");
fleet = await fleetFixture({
  phase: "paused", nodes: [goodCanary, { id: "node_a18" }],
  commands: [canaryAttempt, oldFailure, repeatedFailure]
});
assert.equal(fleet.policy.phase, "fleet", "old duplicate failures must not trap a verified fleet");
assert.equal(fleet.policy.pause_reason, null);
assert.equal(fleet.audits[0].action, "agent.rollout.fleet_recovered");

for (const phase of ["fleet", "paused"]) {
  fleet = await fleetFixture({
    phase, nodes: [goodCanary, { id: "node_a18" }, { id: "node_a19" }],
    commands: [canaryAttempt, oldFailure, { id: "second_failure", node: "node_a19" }]
  });
  assert.equal(fleet.policy.phase, "paused", "two distinct failures must retain the safety pause");
  assert.equal(fleet.policy.failed_node_count, 2);
  assert.equal(fleet.audits.length, 0, "a continuing failure must not claim recovery");
}
fleet = await fleetFixture({
  phase: "paused", nodes: [goodCanary, { id: "node_a18", version: "0.3.40" }, { id: "node_a19" }],
  commands: [canaryAttempt, oldFailure, { id: "second_failure", node: "node_a19" }]
});
assert.equal(fleet.policy.phase, "fleet", "a fresh target heartbeat must override a failed acknowledgement");
assert.equal(fleet.policy.failed_node_count, 1);

fleet = await fleetFixture({
  phase: "paused", nodes: [{ ...goodCanary, seen: stamp(40_000) }, { id: "node_a18" }],
  commands: [canaryAttempt, oldFailure, { id: "retry", node: "node_a18", status: "pending", completed: null }]
});
assert.equal(fleet.policy.phase, "paused", "recovery requires heartbeat evidence newer than completion");
assert.equal(fleet.audits.length, 0);
fleet = await fleetFixture({
  nodes: [goodCanary, { id: "node_a18" }, { id: "node_a19", status: "revoked" }],
  commands: [canaryAttempt, { ...oldFailure, version: "0.3.39" }, { id: "revoked", node: "node_a19" }]
});
assert.equal(fleet.policy.failed_node_count, 0, "unrelated releases and revoked nodes are outside this fleet");

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
