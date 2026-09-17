const baseUrl = (process.argv[2] || process.env.CITADEL_BASE_URL || "https://citadel-ai.init1.workers.dev").replace(/\/$/, "");
const deploySha = process.env.DEPLOY_SHA || "manual";
const attempts = Number(process.env.SMOKE_ATTEMPTS || 20);
const delayMs = Number(process.env.SMOKE_DELAY_MS || 3000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(path, attempt) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${baseUrl}${path}${separator}deployment=${encodeURIComponent(deploySha)}-${attempt}`, {
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return response.json();
}

async function getText(path, attempt) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${baseUrl}${path}${separator}deployment=${encodeURIComponent(deploySha)}-${attempt}`, {
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return response.text();
}

function assertReady(health, hub, api, root) {
  const requiredReady = [
    "controller_signing",
    "report_storage",
    "session_storage",
    "telemetry_storage",
    "presence_storage"
  ];
  if (health.ok !== true) throw new Error("health.ok is not true");
  for (const field of requiredReady) {
    if (health[field] !== "ready") throw new Error(`${field} is not ready`);
  }
  if (hub.ok !== true || !Array.isArray(hub.nodes)) throw new Error("Hub API is invalid");
  for (const node of hub.nodes) {
    if ("public_ip" in node || "hostname" in node || "os_name" in node) {
      throw new Error("public Hub leaked protected node presence fields");
    }
  }
  if (api.ok !== true || api.arbitrary_remote_execution !== false) {
    throw new Error("API safety declaration is invalid");
  }
  if (!Array.isArray(api.command_types) || !api.command_types.includes("update")) {
    throw new Error("signed update command is unavailable");
  }
  if (!root.includes("נתונים אמיתיים בלבד")) throw new Error("real-data landing marker missing");
  if (root.includes("ews-demo-has-project")) throw new Error("demo state leaked into live root");
}

let lastError;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const [health, hub, api, root] = await Promise.all([
      getJson("/api/health", attempt),
      getJson("/api/v1/hub/nodes", attempt),
      getJson("/api/v1", attempt),
      getText("/", attempt)
    ]);
    assertReady(health, hub, api, root);
    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      deploy_sha: deploySha,
      registered_nodes: hub.nodes.length,
      checked_at: new Date().toISOString()
    }));
    process.exit(0);
  } catch (error) {
    lastError = error;
    console.error(`smoke attempt ${attempt}/${attempts} failed: ${error.message}`);
    if (attempt < attempts) await sleep(delayMs);
  }
}

console.error(`CITADEL smoke test failed: ${lastError?.message || "unknown error"}`);
process.exit(1);
