import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync("src/index.js", "utf8");
const hub = fs.readFileSync("hub.html", "utf8");
const publicHub = fs.readFileSync("live-index.html", "utf8");

const FREE_DAILY_ROWS_READ = 5_000_000;
const POLL_SECONDS = 30;
const POLLS_PER_DAY = 86_400 / POLL_SECONDS;
const HUB_REFRESH_SECONDS = 60;
const HUB_POLLS_PER_DAY = 86_400 / HUB_REFRESH_SECONDS;
const PUBLIC_HUB_REFRESH_SECONDS = 300;
const PUBLIC_HUB_POLLS_PER_DAY = 86_400 / PUBLIC_HUB_REFRESH_SECONDS;

// Steady-state idle path after #197 hot-polling reduction.
// Each unit is one bounded indexed target/probe row-equivalent. UPDATE target
// matching is counted as a read-equivalent for conservatism. Cloudflare
// Analytics remains authoritative for production billing/quota accounting.
const COMMAND_POLL_ROW_EQUIVALENTS = 2; // node auth + active command probe
const ASSIGNMENT_POLL_ROW_EQUIVALENTS = 3; // node auth + planned-work probe + active assignment probe
const HEARTBEAT_ROW_EQUIVALENTS = 2; // node auth + node UPDATE target
const ROW_EQUIVALENTS_PER_POLL =
  COMMAND_POLL_ROW_EQUIVALENTS +
  ASSIGNMENT_POLL_ROW_EQUIVALENTS +
  HEARTBEAT_ROW_EQUIVALENTS +
  3; // one indexed legacy nonce lookup per signed request in this three-route model

// Secure Hub now uses the bounded fleet snapshot rather than architectOverview.
// Approximation: two indexed/joined row-equivalents per node for /machines,
// one presence row per node, plus authentication reads for both endpoints.
// Release metadata is D1-free apart from auth and is refreshed only every 10m.
const MACHINE_ROW_EQUIVALENTS_PER_NODE = 2;
const PRESENCE_ROW_EQUIVALENTS_PER_NODE = 1;
const HUB_AUTH_ROWS_PER_REFRESH = 2;
const RELEASE_AUTH_POLLS_PER_DAY = 86_400 / 600;

assert.match(index, /if \(!rollout\) return;/, "no-rollout fast return missing");
assert.match(index, /node\.agent_version !== LATEST_NODE_RELEASE\.version/,
  "current agent versions must skip rollout discovery");
assert.match(index, /SELECT work_item_id FROM project_work_items WHERE status = 'planned' LIMIT 1/,
  "planned-work fast probe missing");
assert.match(index, /idx_commands_status_created/,
  "status-first command polling index missing");
assert.match(index, /idx_commands_created_time/,
  "normalized recent-command time index missing");
assert.match(index, /idx_audit_events_target_action/,
  "bounded command-expiry audit lookup index missing");

{
  const overview = index.slice(
    index.indexOf("async function architectOverview"),
    index.indexOf("function publicHubQueryErrorCode")
  );
  assert.doesNotMatch(overview, /await expireStaleCommands\(env\)/,
    "read-only overview must not run stale-command housekeeping");
  assert.match(overview, /ensureCommandReadIndexes\(env\)/,
    "overview must bootstrap bounded command/audit read indexes");
  assert.match(overview, /activeCommandCutoff/,
    "overview must filter stale active commands without cleanup scans");
}

{
  const commandPoll = index.slice(
    index.indexOf("async function listCommands"),
    index.indexOf("async function acknowledgeCommand")
  );
  assert.doesNotMatch(commandPoll, /expireStaleNodeCommands/,
    "steady command polling must not run stale cleanup");
  assert.match(commandPoll, /datetime\(created_at\) >= datetime\(\?\)/,
    "command polling must filter expired active rows through a bounded cutoff");
}

{
  const heartbeat = index.slice(
    index.indexOf("async function heartbeat"),
    index.indexOf("async function listAssignments")
  );
  assert.match(heartbeat, /const node = await authenticateNode\(/,
    "heartbeat must retain the authenticated node used to derive response status");
  assert.doesNotMatch(heartbeat, /SELECT status, last_seen_at FROM nodes/,
    "heartbeat must not re-read the node after a successful update");
}

{
  const wake = index.slice(
    index.indexOf("async function architectWakeNode"),
    index.indexOf("async function architectCreateMission")
  );
  assert.match(wake, /await expireStaleNodeCommands\(env, relay\.node_id\)/,
    "explicit Wake control must reclaim stale relay command slots");
  assert.match(wake, /ORDER BY datetime\(n\.last_seen_at\) DESC/,
    "Wake relay freshness ordering must normalize mixed timestamp formats");
}

{
  const machineRoute = index.slice(
    index.indexOf('if (url.pathname === "/api/v1/architect/machines")'),
    index.indexOf('if (url.pathname === "/api/v1/architect/projects/check")')
  );
  assert.match(machineRoute, /await readArchitectMachines\(env\)/,
    'fleet route must use its read-first storage helper');
  const machines = index.slice(index.indexOf('async function queryArchitectMachines'),
    index.indexOf('async function publicHubNodes'));
  const machineQuery = machines.slice(0, machines.indexOf('async function repairArchitectMachinesStorage'));
  assert.doesNotMatch(machineQuery, /ensure\w+\(env\)/,
    'normal fleet reads must not bootstrap storage or consume D1 writes');
  assert.match(machines, /repairArchitectMachinesStorage\(env, error\)/,
    'missing storage must still use the bounded repair path');
  assert.match(machines, /LIMIT 500/, "fleet snapshot must stay bounded");
  assert.match(machines, /idx_commands_status_created|status IN \('pending','accepted'\)/,
    "fleet command snapshot must remain status-bounded");
  assert.doesNotMatch(machines, /COUNT\(\*\)/,
    "fleet snapshot must not scan historical totals");
}

assert.match(hub, /api\("\/api\/v1\/architect\/machines"\)/,
  "secure Hub must use the bounded fleet snapshot");
{
  const secureRefresh = hub.slice(
    hub.indexOf("async function refreshSecure"),
    hub.indexOf("async function refresh(){")
  );
  assert.doesNotMatch(secureRefresh, /architect\/overview/,
    "secure Hub must not poll the historical overview");
  assert.match(secureRefresh, /releaseFetchedAt>=600000/,
    "static release metadata must be cached for ten minutes");
}
assert.match(hub, /async function refresh\(\)\{if\(document\.hidden\|\|refreshBusy\)return;/,
  "Hub must not poll D1 while the page is hidden");
assert.match(hub, /if\(document\.hidden\|\|!architectToken\|\|!nodeId\)return null;/,
  "LM Studio detail polling must stop while hidden");
assert.match(hub, /visibilitychange/,
  "Hub must refresh once when a hidden page becomes visible again");

assert.match(publicHub, /const PUBLIC_HUB_REFRESH_MS=300000;/,
  "public Hub refresh must be bounded to five minutes");
assert.match(publicHub, /async function refresh\(\)\{\s*if\(document\.hidden\)/,
  "public Hub must not poll D1 while the page is hidden");
assert.match(publicHub, /visibilitychange/,
  "public Hub must resume with one refresh when visible again");
assert.match(publicHub, /if\(!document\.hidden\)scheduleRefresh\(delay\)/,
  "public Hub must not schedule background D1 polling after an in-flight refresh");

function fleetProjection(nodes) {
  const nodePolling = nodes * POLLS_PER_DAY * ROW_EQUIVALENTS_PER_POLL;
  const secureHubPerRefresh =
    HUB_AUTH_ROWS_PER_REFRESH +
    nodes * (MACHINE_ROW_EQUIVALENTS_PER_NODE + PRESENCE_ROW_EQUIVALENTS_PER_NODE);
  const secureHubRows = secureHubPerRefresh * HUB_POLLS_PER_DAY + RELEASE_AUTH_POLLS_PER_DAY;
  const publicHubRows = nodes * PUBLIC_HUB_POLLS_PER_DAY;
  const total = nodePolling + secureHubRows + publicHubRows;
  return {
    nodes,
    node_polling_rows: nodePolling,
    secure_hub_rows: secureHubRows,
    public_hub_rows: publicHubRows,
    projected_rows_read: total,
    daily_limit: FREE_DAILY_ROWS_READ,
    headroom_x: FREE_DAILY_ROWS_READ / total,
    usage_percent: total / FREE_DAILY_ROWS_READ * 100
  };
}

const four = fleetProjection(4);
const twenty = fleetProjection(20);

// Separate writes from reads: replay INSERT + eventual DELETE are charged even
// for idle signed GETs. Include the table, PK and received_at index for each nonce
// mutation, both last_seen indexes on nodes, and five-minute AI refreshes.
const FREE_DAILY_ROWS_WRITTEN = 100_000;
function writeProjection(nodes, sync = true) {
  // All modern signed node routes claim replay IDs in the per-node Durable
  // Object. D1 nonce storage is retained only for D1-only deployments. A
  // configured DO outage rejects requests; it must not switch replay stores.
  const nonceWrites = 0;
  const heartbeatWrites = (86_400 / (sync ? 240 : 30)) * 3;
  const aiWrites = (86_400 / (sync ? 300 : 30)) * 3; // summary + updated_at index + runtime
  const sshWrites = 0; // unchanged probes are now conditional, on sync and legacy heartbeat
  const legacySnapshots = sync ? 0 : POLLS_PER_DAY * 3; // network + presence table/index
  const total = nodes * (nonceWrites + heartbeatWrites + aiWrites + legacySnapshots + sshWrites);
  return {nodes, projected_rows_written: total, daily_limit: FREE_DAILY_ROWS_WRITTEN,
    usage_percent: total / FREE_DAILY_ROWS_WRITTEN * 100,
    within_free_daily_write_limit: total <= FREE_DAILY_ROWS_WRITTEN};
}
const syncFour = writeProjection(4);
assert.ok(syncFour.projected_rows_written <= FREE_DAILY_ROWS_WRITTEN * 0.1,
  'four idle sync nodes must use <=10% of the daily D1 write limit');
assert.equal(writeProjection(50).within_free_daily_write_limit, true,
  'fifty stable sync nodes should fit the modeled Free daily D1 write limit');
assert.equal(writeProjection(50).projected_rows_written, 97_200,
  'include the AI summary index; fifty idle nodes leave only 2.8% before shared/exceptional writes');

assert.ok(four.headroom_x >= 10, "4-node projection must keep >=10x D1 read headroom");
assert.ok(twenty.headroom_x >= 7, "20-node projection including replay migration lookups must keep >=7x D1 read headroom");

console.log(JSON.stringify({
  model: "citadel.d1-steady-poll-budget.v4",
  assumptions: {
    poll_seconds: POLL_SECONDS,
    row_equivalents_per_agent_poll: ROW_EQUIVALENTS_PER_POLL,
    secure_hub_refresh_seconds: HUB_REFRESH_SECONDS,
    public_hub_refresh_seconds: PUBLIC_HUB_REFRESH_SECONDS,
    machine_row_equivalents_per_node: MACHINE_ROW_EQUIVALENTS_PER_NODE,
    presence_row_equivalents_per_node: PRESENCE_ROW_EQUIVALENTS_PER_NODE,
    note: "Read projection retains the legacy three-poll estimate for comparison. Writes include modern signed replay IDs in the per-node Durable Object on every route, 4m persisted heartbeat, unchanged SSH/network/presence/hardware and 5m AI refresh including its index. Fifty stable nodes leave only 2.8% before guardian, tasks, logs, startup, browser auth and other databases. Production Cloudflare Analytics remains authoritative."
  },
  fleets: [four, twenty],
  writes: {legacy_four_nodes: writeProjection(4, false), sync_four_nodes: syncFour,
    sync_twenty_nodes: writeProjection(20), sync_twenty_seven_nodes: writeProjection(27), sync_fifty_nodes: writeProjection(50)}
}, null, 2));
