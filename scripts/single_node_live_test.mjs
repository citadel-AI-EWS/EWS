const baseUrl = (process.env.CITADEL_BASE_URL || "https://citadel-ai.init1.workers.dev").replace(/\/$/, "");
const maxHeartbeatAgeSeconds = Number(process.env.MAX_HEARTBEAT_AGE_SECONDS || 180);

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}?single_node_test=${Date.now()}`, {
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return response.json();
}

function fail(message) {
  throw new Error(message);
}

const [health, hub, api] = await Promise.all([
  getJson("/api/health"),
  getJson("/api/v1/hub/nodes"),
  getJson("/api/v1")
]);

if (health.ok !== true) fail("controller health is not ready");
if (!Array.isArray(hub.nodes)) fail("hub nodes payload is invalid");
if (hub.nodes.length < 1) fail("no registered computer is visible in the live Hub");
if (api.arbitrary_remote_execution !== false) fail("arbitrary remote execution safety contract changed");

const node = hub.nodes[0];
if (!Number.isInteger(node.node_number) || node.node_number < 1) fail("node_number is invalid");
if (typeof node.agent_version !== "string" || !node.agent_version.trim()) fail("agent_version is missing");
if (!["online", "paused"].includes(node.status)) fail(`node status is not operational: ${node.status}`);
if ("public_ip" in node || "hostname" in node || "os_name" in node) fail("public Hub leaked protected node fields");

const lastSeenMs = Date.parse(node.last_seen_at || "");
if (!Number.isFinite(lastSeenMs)) fail("last_seen_at is missing or invalid");
const ageSeconds = Math.max(0, Math.floor((Date.now() - lastSeenMs) / 1000));
if (node.status === "online" && ageSeconds > maxHeartbeatAgeSeconds) {
  fail(`heartbeat is stale: ${ageSeconds}s > ${maxHeartbeatAgeSeconds}s`);
}

console.log(JSON.stringify({
  ok: true,
  test: "single-live-node",
  base_url: baseUrl,
  registered_nodes: hub.nodes.length,
  node: {
    node_number: node.node_number,
    agent_version: node.agent_version,
    status: node.status,
    last_seen_at: node.last_seen_at,
    heartbeat_age_seconds: ageSeconds
  },
  privacy: "protected_fields_not_public",
  checked_at: new Date().toISOString()
}));
