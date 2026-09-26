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
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`${path} HTTP ${response.status} · ${body}`);
  }
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
  for (const field of ["project_online_nodes", "project_ai_ready_workers", "project_python_ready_workers"]) {
    if (!Number.isInteger(health[field]) || health[field] < 0) {
      throw new Error(`health.${field} is invalid`);
    }
  }
  if (!["ready", "waiting_for_ai_worker", "waiting_for_online_node", "unavailable"].includes(health.project_execution)) {
    throw new Error("health.project_execution is invalid");
  }
  if (health.project_readiness_error !== null && typeof health.project_readiness_error !== "string") {
    throw new Error("health.project_readiness_error is invalid");
  }
  if (!["configured", "unconfigured"].includes(health.openrouter_quality)) {
    throw new Error("health.openrouter_quality is invalid");
  }
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
  if (!['id="machines"', 'id="logs"', 'id="taskForm"'].every(marker => root.includes(marker))) throw new Error("operations console markers missing");
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
      project_execution: health.project_execution,
      openrouter_quality: health.openrouter_quality,
      project_readiness_error: health.project_readiness_error,
      project_online_nodes: health.project_online_nodes,
      project_ai_ready_workers: health.project_ai_ready_workers,
      project_python_ready_workers: health.project_python_ready_workers,
      checked_at: new Date().toISOString()
    }));
    process.exit(0);
  } catch (error) {
    lastError = error;
    console.error(`smoke attempt ${attempt}/${attempts} failed: ${error.message}`);
    if (String(error?.message || "").includes("hub_d1_daily_read_limit_exceeded")) {
      console.error("D1 daily read quota is exhausted; retries cannot recover before the quota reset.");
      break;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
}

console.error(`CITADEL smoke test failed: ${lastError?.message || "unknown error"}`);
process.exit(1);
