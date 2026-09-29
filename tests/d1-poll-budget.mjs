import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync("src/index.js", "utf8");

const FREE_DAILY_ROWS_READ = 5_000_000;
const POLL_SECONDS = 30;
const POLLS_PER_DAY = 86_400 / POLL_SECONDS;

// Steady-state idle path after #197 hot-polling reduction.
// Each unit is one bounded indexed target/probe row. This deliberately counts
// UPDATE target matching as a read-equivalent for budget conservatism; actual
// Cloudflare Analytics remains the authority for production usage.
const COMMAND_POLL_ROW_EQUIVALENTS = 2; // node auth + active command probe; current versions skip rollout discovery
const ASSIGNMENT_POLL_ROW_EQUIVALENTS = 3; // node auth + planned-work probe + active assignment probe
const HEARTBEAT_ROW_EQUIVALENTS = 2; // node auth + node UPDATE target
const ROW_EQUIVALENTS_PER_POLL =
  COMMAND_POLL_ROW_EQUIVALENTS +
  ASSIGNMENT_POLL_ROW_EQUIVALENTS +
  HEARTBEAT_ROW_EQUIVALENTS;

assert.match(index, /if \(!rollout\) return;/, "no-rollout fast return missing");
assert.match(index, /node\.agent_version !== LATEST_NODE_RELEASE\.version/,
  "current agent versions must skip rollout discovery");
assert.match(index, /SELECT work_item_id FROM project_work_items WHERE status = 'planned' LIMIT 1/,
  "planned-work fast probe missing");
assert.doesNotMatch(
  index.slice(index.indexOf("async function listCommands"), index.indexOf("async function acknowledgeCommand")),
  /expireStaleNodeCommands/,
  "steady command polling must not run stale cleanup"
);
{
  const heartbeat = index.slice(index.indexOf("async function heartbeat"), index.indexOf("async function listAssignments"));
  assert.doesNotMatch(heartbeat, /SELECT status, last_seen_at FROM nodes/,
    "heartbeat must not re-read the node after a successful update");
}

function fleetProjection(nodes) {
  const nodePolling = nodes * POLLS_PER_DAY * ROW_EQUIVALENTS_PER_POLL;
  // One continuously open public Hub refreshing once/minute. Its node query
  // returns at most one row per node in this representative fleet.
  const hubRows = nodes * (86_400 / 60);
  const total = nodePolling + hubRows;
  return {
    nodes,
    node_polling_rows: nodePolling,
    hub_rows: hubRows,
    projected_rows_read: total,
    daily_limit: FREE_DAILY_ROWS_READ,
    headroom_x: FREE_DAILY_ROWS_READ / total,
    usage_percent: total / FREE_DAILY_ROWS_READ * 100
  };
}

const four = fleetProjection(4);
const twenty = fleetProjection(20);

assert.ok(four.headroom_x >= 10, "4-node projection must keep >=10x D1 read headroom");
assert.ok(twenty.headroom_x >= 10, "20-node projection must keep >=10x D1 read headroom");

console.log(JSON.stringify({
  model: "citadel.d1-steady-poll-budget.v1",
  assumptions: {
    poll_seconds: POLL_SECONDS,
    row_equivalents_per_poll: ROW_EQUIVALENTS_PER_POLL,
    public_hub_refresh_seconds: 60,
    note: "Projection covers steady idle/control polling with one continuously open public Hub; production Analytics is authoritative."
  },
  fleets: [four, twenty]
}, null, 2));
