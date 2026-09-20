import { getProjectExperienceRegistry } from "./experience/registry.js";
import { openRouterQualityConfig, reviewWithOpenRouter } from "./quality/openrouter.js";
import { ARCHITECT_ROLE_PERMISSIONS, DEFAULT_ENTERPRISE_POLICY, evaluateEnterpriseNode, normalizeEnterprisePolicy, requiredArchitectPermission, roleHasPermission } from "./enterprise/policy.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

const MAX_ENROLLMENT_BODY_BYTES = 16 * 1024;
const MAX_NODE_BODY_BYTES = 64 * 1024;
const MAX_RESULT_BODY_BYTES = 768 * 1024;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_SESSION_BODY_BYTES = 24 * 1024;
const MAX_SESSION_SNAPSHOT_BYTES = 16 * 1024;
const SIGNATURE_WINDOW_SECONDS = 300;
const COMMAND_MAX_AGE_SECONDS = 15 * 60;
const REPLAY_PROTECTED_AGENT_VERSION = "0.3.10";
const AUTO_ENROLLMENT_DEFAULT_HOURLY_LIMIT = 120;
const AUTO_ENROLLMENT_DEFAULT_NODE_CAP = 10000;
const ALLOWED_OUTCOMES = new Set(["success", "failed", "partial"]);
const ALLOWED_REPORT_SENSITIVITIES = new Set([
  "public",
  "internal",
  "confidential",
  "restricted"
]);
const ALLOWED_COMMAND_ACKS = new Set(["accepted", "completed", "failed"]);
const ALLOWED_ARCHITECT_MISSION_TYPES = new Set(["system_inventory"]);
const ALLOWED_ARCHITECT_COMMAND_TYPES = new Set(["pause", "resume", "update", "restart", "stop", "rollback", "uninstall", "system_reboot", "system_shutdown", "lmstudio_install", "lmstudio_probe", "lmstudio_model_get", "lmstudio_model_load", "hybrid_query"]);
const POWER_COMMAND_CONFIRMATIONS = Object.freeze({ system_reboot: "REBOOT", system_shutdown: "SHUTDOWN" });
const LATEST_NODE_RELEASE = Object.freeze({
  version: "0.3.13",
  files: [
    {
      path: "citadel_node_v1.py",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/citadel_node_v1.py",
      sha256: "a39c41b4e5ae0cd8cbfe28b74cbadb4e3806c03ebe3a3fbfc1464dc01dcd68e6"
    },
    {
      path: "citadel_node_v2.py",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/citadel_node_v2.py",
      sha256: "43d6d8492d43e3434c7ce90c946804c7cc1c05344ae3aaf27c7ed8220d34e803"
    },
    {
      path: "windows_enterprise_probe.ps1",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/windows_enterprise_probe.ps1",
      sha256: "0d056ab71e2216821cd314a97bc14e87f87c60140a0bcf787a24cfa33212c2ee"
    }
  ]
});
const LMSTUDIO_INTEGRATION = Object.freeze({
  github_url: "https://github.com/citadel-AI-EWS/EWS/tree/main/agent/lmstudio",
  official_url: "https://lmstudio.ai",
  server_url: "http://127.0.0.1:1234",
  windows_asset: Object.freeze({
    path: "install_llmstudio_headless.ps1",
    url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/lmstudio/install_llmstudio_headless.ps1",
    sha256: "d9a96026bea2e7729f0b086d8d668c3f4f93b7725b5e0af3f2936b68f89475cf"
  }),
  linux_asset: Object.freeze({
    path: "install_llmstudio_headless.sh",
    url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/lmstudio/install_llmstudio_headless.sh",
    sha256: "15dcfd76d3c929ec2ca459a19879d565a9ec6483c33fcf9b3d8ba5a8ef145d39"
  }),
  model_presets: Object.freeze([
    { id: "ibm/granite-4-micro", label: "IBM Granite 4 Micro" },
    { id: "openai/gpt-oss-20b", label: "OpenAI GPT-OSS 20B" }
  ])
});
const CONTROLLER_COMMAND_PUBLIC_X = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0";
let reportSchemaPromise;
let legacyReportBackfillPromise;
let sessionSchemaPromise;
let commandIndexPromise;
let nodeNetworkSchemaPromise;
let rolloutSchemaPromise;
let projectSchemaPromise;
let nodeAiSchemaPromise;
let nodeRequestNonceSchemaPromise;
let qualityGateSchemaPromise;
let architectAuthSchemaPromise;
let enterpriseSchemaPromise;

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function methodNotAllowed(methods) {
  return json(
    { ok: false, error: "method_not_allowed" },
    405,
    { allow: methods.join(", ") }
  );
}

function requireString(value, field, maxLength) {
  if (typeof value !== "string") {
    throw new ApiError(400, `invalid_${field}`);
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ApiError(400, `invalid_${field}`);
  }
  return normalized;
}

function optionalString(value, field, maxLength) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return requireString(value, field, maxLength);
}

function optionalPercent(value, field) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new ApiError(400, `invalid_${field}`);
  }
  return value;
}

function normalizeIpv4(value, privateOnly = false) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, "invalid_network_ipv4");
  const parts = value.trim().split(".");
  if (parts.length !== 4) throw new ApiError(400, "invalid_network_ipv4");
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part, index) =>
    !Number.isInteger(part) || part < 0 || part > 255 ||
    String(part) !== String(Number(parts[index]))
  )) throw new ApiError(400, "invalid_network_ipv4");
  if (privateOnly) {
    const [a,b] = numbers;
    const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    if (!isPrivate) return null;
  }
  return numbers.join(".");
}

function normalizeMac(value) {
  if (typeof value !== "string") return null;
  const compact = value.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(compact) || compact === "000000000000") return null;
  return compact.match(/.{2}/g).join(":");
}

function normalizeNodeNetwork(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_network");
  }
  const rawMacs = Array.isArray(value.mac_addresses) ? value.mac_addresses : [];
  if (rawMacs.length > 32) throw new ApiError(400, "too_many_mac_addresses");
  const macAddresses = [...new Set(rawMacs.map(normalizeMac).filter(Boolean))].slice(0, 16);
  return {
    lan_ipv4: normalizeIpv4(value.lan_ipv4, true),
    tailscale_ipv4: normalizeIpv4(value.tailscale_ipv4, false),
    mac_addresses: macAddresses
  };
}

function subnet24(value) {
  const parts = typeof value === "string" ? value.split(".") : [];
  return parts.length === 4 ? parts.slice(0, 3).join(".") : null;
}

function agentRequiresRequestId(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  return major > 0 || minor > 3 || (minor === 3 && patch >= 10);
}

function parseJsonObject(text) {
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "invalid_json");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "json_object_required");
  }
  return value;
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readBody(request, maxBytes) {
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null && rawLength !== "") {
    if (!/^\d+$/.test(rawLength)) {
      throw new ApiError(400, "invalid_content_length");
    }
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      throw new ApiError(413, "request_too_large");
    }
  }

  if (!request.body) {
    return { bytes: new Uint8Array(0), text: "" };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request_too_large").catch(() => {});
        throw new ApiError(413, "request_too_large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(400, "invalid_utf8");
  }
  return { bytes, text };
}

async function readBodyText(request, maxBytes) {
  return (await readBody(request, maxBytes)).text;
}

async function ensureReportStorage(env) {
  if (!reportSchemaPromise) {
    reportSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS agent_reports (
          report_id TEXT PRIMARY KEY,
          result_id TEXT NOT NULL UNIQUE,
          assignment_id TEXT NOT NULL,
          mission_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          report_type TEXT NOT NULL,
          report_json TEXT NOT NULL,
          report_sha256 TEXT NOT NULL,
          report_size_bytes INTEGER NOT NULL CHECK (report_size_bytes >= 0),
          sensitivity TEXT NOT NULL DEFAULT 'internal'
            CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (result_id) REFERENCES results(result_id) ON DELETE CASCADE,
          FOREIGN KEY (assignment_id) REFERENCES assignments(assignment_id) ON DELETE CASCADE,
          FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_agent_reports_node_created
        ON agent_reports(node_id, created_at DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_agent_reports_mission_created
        ON agent_reports(mission_id, created_at DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_agent_reports_type_created
        ON agent_reports(report_type, created_at DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_agent_reports_created
        ON agent_reports(created_at DESC)
      `)
    ]).catch((error) => {
      reportSchemaPromise = undefined;
      throw error;
    });
  }
  await reportSchemaPromise;
}

async function backfillLegacyReports(env) {
  await ensureReportStorage(env);
  if (!legacyReportBackfillPromise) {
    legacyReportBackfillPromise = env.DB.prepare(`
      INSERT OR IGNORE INTO agent_reports (
        report_id, result_id, assignment_id, mission_id, node_id,
        report_type, report_json, report_sha256, report_size_bytes,
        sensitivity, created_at
      )
      SELECT
        'report_' || r.result_id,
        r.result_id,
        r.assignment_id,
        a.mission_id,
        r.node_id,
        COALESCE(NULLIF(r.report_type, ''), 'mission_result'),
        r.report_json,
        r.report_sha256,
        r.report_size_bytes,
        COALESCE(NULLIF(r.sensitivity, ''), 'internal'),
        r.created_at
      FROM results AS r
      JOIN assignments AS a ON a.assignment_id = r.assignment_id
      WHERE r.report_json IS NOT NULL
        AND r.report_sha256 IS NOT NULL
        AND r.report_size_bytes IS NOT NULL
    `).run().catch((error) => {
      const message = String(error).toLowerCase();
      if (message.includes("no such column")) {
        return { meta: { changes: 0 } };
      }
      legacyReportBackfillPromise = undefined;
      throw error;
    });
  }
  await legacyReportBackfillPromise;
}

async function ensureSessionStorage(env) {
  if (!sessionSchemaPromise) {
    sessionSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS architect_sessions (
          session_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          schema_version INTEGER NOT NULL DEFAULT 1,
          snapshot_json TEXT NOT NULL,
          snapshot_sha256 TEXT NOT NULL,
          snapshot_size_bytes INTEGER NOT NULL CHECK (snapshot_size_bytes >= 0),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'archived')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_architect_sessions_status_updated
        ON architect_sessions(status, updated_at DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_architect_sessions_updated
        ON architect_sessions(updated_at DESC, session_id DESC)
      `)
    ]).catch((error) => {
      sessionSchemaPromise = undefined;
      throw error;
    });
  }
  await sessionSchemaPromise;
}

async function ensureCommandStorage(env) {
  if (!commandIndexPromise) {
    commandIndexPromise = env.DB.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_one_active_per_node
      ON commands(node_id)
      WHERE status IN ('pending', 'accepted')
    `).run().catch((error) => {
      commandIndexPromise = undefined;
      throw error;
    });
  }
  await commandIndexPromise;
}

async function ensureNodeRequestNonceStorage(env) {
  if (!nodeRequestNonceSchemaPromise) {
    nodeRequestNonceSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS node_request_nonces (
          node_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (node_id, request_id),
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_request_nonces_received
        ON node_request_nonces(received_at)
      `)
    ]).catch((error) => {
      nodeRequestNonceSchemaPromise = undefined;
      throw error;
    });
  }
  await nodeRequestNonceSchemaPromise;
}

async function ensureNodeNetworkStorage(env) {
  if (!nodeNetworkSchemaPromise) {
    nodeNetworkSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS node_network_state (
          node_id TEXT PRIMARY KEY,
          lan_ipv4 TEXT,
          tailscale_ipv4 TEXT,
          mac_addresses_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_network_lan
        ON node_network_state(lan_ipv4, updated_at DESC)
      `)
    ]).catch((error) => {
      nodeNetworkSchemaPromise = undefined;
      throw error;
    });
  }
  await nodeNetworkSchemaPromise;
}

async function ensureNodeAiStorage(env) {
  if (!nodeAiSchemaPromise) {
    nodeAiSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS node_ai_state (
          node_id TEXT PRIMARY KEY,
          runtime TEXT NOT NULL DEFAULT 'lmstudio',
          installed INTEGER NOT NULL DEFAULT 0 CHECK (installed IN (0,1)),
          selected_model TEXT,
          loaded_model TEXT,
          server_running INTEGER NOT NULL DEFAULT 0 CHECK (server_running IN (0,1)),
          last_action TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_ai_state_updated
        ON node_ai_state(updated_at DESC)
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS node_ai_runtime_state (
          node_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
        )
      `)
    ]).catch((error) => {
      nodeAiSchemaPromise = undefined;
      throw error;
    });
  }
  await nodeAiSchemaPromise;
}

async function upsertNodeAiState(env, nodeId, state) {
  if (!state) return;
  await ensureNodeAiStorage(env);
  const stateJson = JSON.stringify(state);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO node_ai_state (
        node_id, installed, selected_model, loaded_model, server_running, last_action, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(node_id) DO UPDATE SET
        installed = excluded.installed,
        selected_model = COALESCE(excluded.selected_model, node_ai_state.selected_model),
        loaded_model = excluded.loaded_model,
        server_running = excluded.server_running,
        last_action = COALESCE(excluded.last_action, node_ai_state.last_action),
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      nodeId,
      state.installed,
      state.selected_model,
      state.loaded_model,
      state.server_running,
      state.last_action
    ),
    env.DB.prepare(`
      INSERT INTO node_ai_runtime_state (node_id, state_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(node_id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = CURRENT_TIMESTAMP
    `).bind(nodeId, stateJson)
  ]);
}

async function nodeAiStateResponse(env, nodeId) {
  await ensureNodeAiStorage(env);
  const row = await env.DB.prepare(`
    SELECT ai.node_id, ai.runtime, ai.installed, ai.selected_model, ai.loaded_model,
      ai.server_running, ai.last_action, ai.updated_at,
      runtime.state_json AS runtime_state_json,
      runtime.updated_at AS runtime_updated_at
    FROM node_ai_state AS ai
    LEFT JOIN node_ai_runtime_state AS runtime ON runtime.node_id = ai.node_id
    WHERE ai.node_id = ?
  `).bind(nodeId).first();
  if (!row) {
    return {
      node_id: nodeId, runtime: "lmstudio", installed: 0, server_running: 0,
      selected_model: null, loaded_model: null
    };
  }
  const detail = safeJson(row.runtime_state_json, {});
  return {
    ...detail,
    node_id: row.node_id,
    runtime: row.runtime,
    installed: row.installed,
    selected_model: row.selected_model,
    loaded_model: row.loaded_model,
    server_running: row.server_running,
    last_action: row.last_action,
    updated_at: row.updated_at,
    runtime_updated_at: row.runtime_updated_at
  };
}

function lmstudioInstallAssetForNode(node) {
  const osName = String(node?.os_name || "").toLowerCase();
  if (osName.includes("windows")) return LMSTUDIO_INTEGRATION.windows_asset;
  if (osName.includes("linux")) return LMSTUDIO_INTEGRATION.linux_asset;
  throw new ApiError(409, "lmstudio_platform_not_supported");
}

async function ensureRolloutStorage(env) {
  if (!rolloutSchemaPromise) {
    rolloutSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS agent_rollouts (
          rollout_id TEXT PRIMARY KEY,
          target_version TEXT NOT NULL,
          release_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'completed', 'cancelled')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      env.DB.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_rollouts_one_active
        ON agent_rollouts(status)
        WHERE status = 'active'
      `)
    ]).catch((error) => {
      rolloutSchemaPromise = undefined;
      throw error;
    });
  }
  await rolloutSchemaPromise;
}

async function startUpdateAllRollout(request, env) {
  await authenticateArchitect(request, env);
  await ensureRolloutStorage(env);
  const releaseJson = JSON.stringify(LATEST_NODE_RELEASE);
  const rolloutId = "rollout_" + crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE agent_rollouts SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE status = 'active'"
    ),
    env.DB.prepare(
      "INSERT INTO agent_rollouts (rollout_id, target_version, release_json, status) VALUES (?, ?, ?, 'active')"
    ).bind(rolloutId, LATEST_NODE_RELEASE.version, releaseJson),
    env.DB.prepare(
      "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
      "VALUES ('architect', 'test-console', 'agent.rollout.started', 'rollout', ?, ?)"
    ).bind(rolloutId, JSON.stringify({ target_version: LATEST_NODE_RELEASE.version }))
  ]);
  const counts = await env.DB.prepare(
    "SELECT COUNT(*) AS total, " +
    "SUM(CASE WHEN status != 'revoked' AND agent_version != ? THEN 1 ELSE 0 END) AS outdated " +
    "FROM nodes"
  ).bind(LATEST_NODE_RELEASE.version).first();
  return json({
    ok: true,
    rollout: {
      rollout_id: rolloutId,
      target_version: LATEST_NODE_RELEASE.version,
      status: "active",
      registered_nodes: Number(counts?.total || 0),
      nodes_waiting_for_update: Number(counts?.outdated || 0)
    }
  }, 201);
}

async function ensureRolloutCommandForNode(env, nodeId) {
  await Promise.all([ensureRolloutStorage(env), ensureCommandStorage(env)]);
  const [rollout, node, pending, recentCompletedUpdate] = await Promise.all([
    env.DB.prepare(
      "SELECT rollout_id, target_version, release_json FROM agent_rollouts WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
    ).first(),
    env.DB.prepare(
      "SELECT node_id, status, agent_version FROM nodes WHERE node_id = ?"
    ).bind(nodeId).first(),
    env.DB.prepare(
      "SELECT command_id FROM commands WHERE node_id = ? AND status IN ('pending', 'accepted') LIMIT 1"
    ).bind(nodeId).first(),
    env.DB.prepare(
      "SELECT payload_json, completed_at FROM commands " +
      "WHERE node_id = ? AND command_type = 'update' AND status = 'completed' " +
      "AND datetime(completed_at) >= datetime('now', '-10 minutes') " +
      "ORDER BY completed_at DESC LIMIT 1"
    ).bind(nodeId).first()
  ]);
  if (!rollout || !node || pending || node.status === "revoked" || node.agent_version === rollout.target_version) {
    return;
  }
  const recentlyInstalled = recentCompletedUpdate
    ? safeJson(recentCompletedUpdate.payload_json, {})?.version === rollout.target_version
    : false;
  if (recentlyInstalled) return;
  if (rollout.target_version !== LATEST_NODE_RELEASE.version) return;
  const commandId = "command_" + crypto.randomUUID();
  const payloadJson = rollout.release_json;
  const createdAt = new Date().toISOString();
  const signature = await signControllerCommand(
    env, commandId, nodeId, "update", payloadJson, createdAt
  );
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO commands (command_id, node_id, command_type, payload_json, signature, status, created_at) " +
        "VALUES (?, ?, 'update', ?, ?, 'pending', ?)"
      ).bind(commandId, nodeId, payloadJson, signature, createdAt),
      env.DB.prepare(
        "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
        "VALUES ('controller', ?, 'agent.rollout.command_created', 'command', ?, ?)"
      ).bind(rollout.rollout_id, commandId, JSON.stringify({ node_id: nodeId, target_version: rollout.target_version }))
    ]);
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
  }
}

const WORK_ROLE_REGISTRY = Object.freeze([
  { id: "architect", label: "Architect", kind: "human_gate", origin: "project_control" },
  { id: "planner", label: "Planner", kind: "worker", origin: "legacy_simulation" },
  { id: "verifier", label: "Verifier", kind: "worker", origin: "legacy_simulation" },
  { id: "researcher", label: "Research", kind: "worker", origin: "legacy_simulation" },
  { id: "reporter", label: "Report", kind: "worker", origin: "legacy_simulation" },
  { id: "metrics", label: "Metrics", kind: "worker", origin: "legacy_simulation" },
  { id: "recovery", label: "Recovery", kind: "worker", origin: "legacy_simulation" },
  { id: "programmer", label: "Programmer", kind: "worker", origin: "architect_extension_2026_09_18" },
  { id: "mathematician", label: "Mathematician", kind: "worker", origin: "architect_extension_2026_09_18" },
  { id: "security_analyst", label: "Security Analyst", kind: "worker", origin: "architect_extension_2026_09_18" }
]);

const WORKER_ROLE_IDS = new Set(
  WORK_ROLE_REGISTRY.filter((role) => role.kind === "worker").map((role) => role.id)
);

function normalizeRequestedProjectRoles(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > WORKER_ROLE_IDS.size) {
    throw new ApiError(400, "invalid_requested_roles");
  }
  const roles = [];
  for (const raw of value) {
    const role = requireString(raw, "requested_role", 64);
    if (!WORKER_ROLE_IDS.has(role)) throw new ApiError(400, "project_role_not_allowed");
    if (!roles.includes(role)) roles.push(role);
  }
  return roles;
}

function roleMetadata(roleId) {
  return WORK_ROLE_REGISTRY.find((role) => role.id === roleId) || {
    id: roleId,
    label: roleId,
    kind: "worker",
    origin: "unknown"
  };
}

function classifyWorkRole(text) {
  const value = String(text || "").toLowerCase();
  const tests = [
    ["security_analyst", /(security|secure|vulnerab|threat|malware|audit|шифр|безопас|уязв|угроз|вредонос)/],
    ["programmer", /(python|javascript|typescript|java|code|coding|program|function|api|sql|html|css|код|программ|функц|скрипт|база данных)/],
    ["mathematician", /(math|equation|formula|algebra|geometry|calculus|probab|combin|математ|формул|уравнен|алгебр|геометр|вероятност)/],
    ["metrics", /(metric|statistics|chart|graph|median|average|variance|метрик|статист|график|медиан|средн)/],
    ["recovery", /(recover|rollback|restore|repair|backup|восстанов|откат|резервн|почин)/],
    ["verifier", /(verify|validation|test|check|qa|proof|провер|тест|валид|доказ)/],
    ["reporter", /(report|summary|summar|document|write-up|отч[её]т|сводк|резюме|документ)/],
    ["researcher", /(research|source|evidence|investig|compare|search|исслед|источник|доказательств|сравн|поиск)/]
  ];
  for (const [role, pattern] of tests) {
    if (pattern.test(value)) return role;
  }
  return "planner";
}

function rolePlanSummary(items) {
  const counts = {};
  for (const item of items) counts[item.role_name] = (counts[item.role_name] || 0) + 1;
  return counts;
}

async function architectWorkRoles(request, env) {
  await authenticateArchitect(request, env);
  return json({ ok: true, roles: WORK_ROLE_REGISTRY });
}

async function ensureProjectStorage(env) {
  if (!projectSchemaPromise) {
    projectSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS architect_projects (
          project_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          source_type TEXT NOT NULL,
          task_text TEXT NOT NULL,
          task_sha256 TEXT NOT NULL,
          checks_json TEXT NOT NULL,
          architect_approved INTEGER NOT NULL DEFAULT 0 CHECK (architect_approved IN (0,1)),
          status TEXT NOT NULL DEFAULT 'planned'
            CHECK (status IN ('planned','running','completed','blocked','cancelled')),
          worker_count INTEGER NOT NULL DEFAULT 0 CHECK (worker_count >= 0),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_architect_projects_hash_status
        ON architect_projects(task_sha256, status, created_at DESC)
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS project_work_items (
          work_item_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
          node_id TEXT,
          role_name TEXT NOT NULL DEFAULT 'planner',
          task_text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'planned'
            CHECK (status IN ('planned','assigned','running','completed','failed','cancelled')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES architect_projects(project_id) ON DELETE CASCADE,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE SET NULL
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_project_work_items_project_sequence
        ON project_work_items(project_id, sequence_no)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_project_work_items_node_status
        ON project_work_items(node_id, status, created_at)
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS project_specializations (
          project_id TEXT NOT NULL,
          role_name TEXT NOT NULL,
          source TEXT NOT NULL
            CHECK (source IN ('hub_recommended','architect_added')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (project_id, role_name),
          FOREIGN KEY (project_id) REFERENCES architect_projects(project_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_project_specializations_project
        ON project_specializations(project_id, created_at)
      `)
    ]).catch((error) => {
      projectSchemaPromise = undefined;
      throw error;
    });
  }
  await projectSchemaPromise;
}


async function ensureQualityGateStorage(env) {
  if (!qualityGateSchemaPromise) {
    qualityGateSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS project_quality_gates (
          project_id TEXT PRIMARY KEY,
          source_sha256 TEXT NOT NULL,
          status TEXT NOT NULL
            CHECK (status IN ('processing','completed','failed')),
          provider TEXT NOT NULL DEFAULT 'openrouter',
          requested_model TEXT,
          resolved_model TEXT,
          fusion_preset TEXT,
          final_text TEXT,
          error_code TEXT,
          claim_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES architect_projects(project_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_project_quality_gates_status
        ON project_quality_gates(status, updated_at)
      `)
    ]).catch((error) => {
      qualityGateSchemaPromise = undefined;
      throw error;
    });
  }
  await qualityGateSchemaPromise;
}

function qualityGateErrorCode(error) {
  const value = typeof error?.code === "string"
    ? error.code
    : (typeof error?.message === "string" ? error.message : "quality_gate_failed");
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "quality_gate_failed";
}

function qualityGateResultFromRow(row, rawText) {
  if (!row) return null;
  if (row.status === "completed" && typeof row.final_text === "string" && row.final_text.trim()) {
    return {
      ready: true,
      status: "completed",
      content: row.final_text,
      reviewed: true,
      model: row.resolved_model || row.requested_model || null,
      error_code: null
    };
  }
  if (row.status === "failed") {
    return {
      ready: true,
      status: "degraded",
      content: rawText,
      reviewed: false,
      model: row.resolved_model || row.requested_model || null,
      error_code: row.error_code || "quality_gate_failed"
    };
  }
  if (row.status === "processing") {
    return {
      ready: false,
      status: "processing",
      content: null,
      reviewed: false,
      model: row.requested_model || null,
      error_code: null
    };
  }
  return null;
}

async function finalizeProjectAnswer(env, projectId, originalTask, rawText) {
  const draft = String(rawText || "").trim();
  if (!draft) {
    return {
      ready: false,
      status: "empty",
      content: null,
      reviewed: false,
      model: null,
      error_code: "empty_project_result"
    };
  }

  const config = openRouterQualityConfig(env);
  if (!config.configured) {
    return {
      ready: true,
      status: "unconfigured",
      content: draft,
      reviewed: false,
      model: null,
      error_code: null
    };
  }

  await ensureQualityGateStorage(env);
  const sourceSha256 = await sha256Hex(
    `${config.model}\n${config.fusionPreset}\n${String(originalTask || "")}\n\u0000${draft}`
  );
  let current = await env.DB.prepare(`
    SELECT project_id, source_sha256, status, requested_model, resolved_model,
      fusion_preset, final_text, error_code, claim_id, updated_at
    FROM project_quality_gates
    WHERE project_id = ?
  `).bind(projectId).first();

  if (current?.source_sha256 === sourceSha256) {
    const cached = qualityGateResultFromRow(current, draft);
    if (cached?.ready || current.status === "processing") {
      if (current.status !== "processing") return cached;
      const newClaimId = crypto.randomUUID();
      const staleClaim = await env.DB.prepare(`
        UPDATE project_quality_gates
        SET claim_id = ?, requested_model = ?, fusion_preset = ?,
            error_code = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ?
          AND source_sha256 = ?
          AND status = 'processing'
          AND datetime(updated_at) < datetime('now', '-5 minutes')
      `).bind(
        newClaimId,
        config.model,
        config.model === "openrouter/fusion" ? config.fusionPreset : null,
        projectId,
        sourceSha256
      ).run();
      if ((staleClaim?.meta?.changes || 0) === 0) return cached;
      current = await env.DB.prepare(`
        SELECT project_id, source_sha256, status, requested_model, resolved_model,
          fusion_preset, final_text, error_code, claim_id, updated_at
        FROM project_quality_gates WHERE project_id = ?
      `).bind(projectId).first();
    }
  }

  const claimId = current?.source_sha256 === sourceSha256 && current?.status === "processing"
    ? current.claim_id
    : crypto.randomUUID();

  if (!(current?.source_sha256 === sourceSha256 && current?.status === "processing")) {
    const claim = await env.DB.prepare(`
      INSERT INTO project_quality_gates (
        project_id, source_sha256, status, provider, requested_model,
        fusion_preset, final_text, error_code, claim_id, updated_at
      ) VALUES (?, ?, 'processing', 'openrouter', ?, ?, NULL, NULL, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(project_id) DO UPDATE SET
        source_sha256 = excluded.source_sha256,
        status = 'processing',
        provider = 'openrouter',
        requested_model = excluded.requested_model,
        resolved_model = NULL,
        fusion_preset = excluded.fusion_preset,
        final_text = NULL,
        error_code = NULL,
        claim_id = excluded.claim_id,
        updated_at = CURRENT_TIMESTAMP
      WHERE project_quality_gates.source_sha256 <> excluded.source_sha256
    `).bind(
      projectId,
      sourceSha256,
      config.model,
      config.model === "openrouter/fusion" ? config.fusionPreset : null,
      claimId
    ).run();

    if ((claim?.meta?.changes || 0) === 0) {
      const row = await env.DB.prepare(`
        SELECT project_id, source_sha256, status, requested_model, resolved_model,
          fusion_preset, final_text, error_code, claim_id, updated_at
        FROM project_quality_gates WHERE project_id = ?
      `).bind(projectId).first();
      return qualityGateResultFromRow(row, draft) || {
        ready: false,
        status: "processing",
        content: null,
        reviewed: false,
        model: config.model,
        error_code: null
      };
    }
  }

  try {
    const reviewed = await reviewWithOpenRouter({
      env,
      originalTask,
      draftAnswer: draft
    });
    const saved = await env.DB.prepare(`
      UPDATE project_quality_gates
      SET status = 'completed',
          resolved_model = ?,
          final_text = ?,
          error_code = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ?
        AND source_sha256 = ?
        AND claim_id = ?
        AND status = 'processing'
    `).bind(reviewed.model, reviewed.content, projectId, sourceSha256, claimId).run();

    if ((saved?.meta?.changes || 0) === 1) {
      return {
        ready: true,
        status: "completed",
        content: reviewed.content,
        reviewed: true,
        model: reviewed.model,
        error_code: null
      };
    }

    const row = await env.DB.prepare(`
      SELECT project_id, source_sha256, status, requested_model, resolved_model,
        fusion_preset, final_text, error_code, claim_id, updated_at
      FROM project_quality_gates WHERE project_id = ?
    `).bind(projectId).first();
    return qualityGateResultFromRow(row, draft) || {
      ready: false,
      status: "processing",
      content: null,
      reviewed: false,
      model: config.model,
      error_code: null
    };
  } catch (error) {
    const errorCode = qualityGateErrorCode(error);
    await env.DB.prepare(`
      UPDATE project_quality_gates
      SET status = 'failed',
          error_code = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ?
        AND source_sha256 = ?
        AND claim_id = ?
        AND status = 'processing'
    `).bind(errorCode, projectId, sourceSha256, claimId).run();

    return {
      ready: true,
      status: "degraded",
      content: draft,
      reviewed: false,
      model: config.model,
      error_code: errorCode
    };
  }
}

function projectSafetyClassification(text) {
  const normalized = text.toLowerCase();
  const prohibitedSignals = [
    /steal\s+(password|credential|token)/,
    /credential\s+theft/,
    /скраст[ьи].{0,20}(парол|токен|уч[её]тн)/,
    /украст[ьи].{0,20}(парол|токен|уч[её]тн)/,
    /self[- ]?propagat/,
    /самораспростран/,
    /stealth\s+persistence/,
    /скрыт.{0,12}(закреп|автозапуск|персист)/,
    /exploit.{0,30}(third[- ]party|чуж)/,
    /взлом.{0,30}(чуж|сторонн)/,
    /autonomous.{0,20}(payment|transaction|trade)/,
    /автономн.{0,20}(плат[её]ж|транзакц|торгов)/
  ];
  const blocked = prohibitedSignals.some((pattern) => pattern.test(normalized));
  return blocked
    ? { classification: "blocked", allowed: false, reason: "project_policy_blocked" }
    : { classification: "bounded_review", allowed: true, reason: "architect_review_required" };
}

function splitProjectText(text, maxChars = 2000) {
  const paragraphs = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const blocks = [];
  let current = "";
  const pushCurrent = () => {
    if (current.trim()) blocks.push(current.trim());
    current = "";
  };
  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    let rest = paragraph;
    while (rest.length > maxChars) {
      const slice = rest.slice(0, maxChars);
      const splitAt = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "), slice.lastIndexOf(" "));
      const cut = splitAt > maxChars * 0.6 ? splitAt + 1 : maxChars;
      const part = rest.slice(0, cut).trim();
      if (current) pushCurrent();
      if (part) blocks.push(part);
      rest = rest.slice(cut).trim();
    }
    if (!rest) continue;
    const candidate = current ? current + "\n\n" + rest : rest;
    if (candidate.length > maxChars) {
      pushCurrent();
      current = rest;
    } else {
      current = candidate;
    }
  }
  pushCurrent();
  return blocks.length ? blocks : [text];
}

function projectWorkerProfile(text, requestedRoles = []) {
  const value = String(text || "").toLowerCase();
  const roles = [];
  const add = (role) => { if (!roles.includes(role)) roles.push(role); };

  const isMath = /(math|equation|formula|algebra|geometry|calculus|probab|combin|математ|формул|уравнен|алгебр|геометр|вероятност|сумм[ау]|числ)/.test(value);
  const isCode = /(python|javascript|typescript|java|code|coding|program|algorithm|api|sql|database|html|css|код|программ|алгоритм|функц|скрипт|база данных)/.test(value);
  const isCyber = /(cyber|security|secure|vulnerab|threat|malware|phishing|sql injection|xss|pentest|hacking|hack|кибер|безопас|уязв|угроз|фишинг|инъекц|взлом)/.test(value);
  const isPhilosophy = /(philosoph|ethic|utilitarian|deontolog|morality|moral|философ|этик|утилитар|деонтолог|морал)/.test(value);
  const asksCompare = /(compare|versus|pros and cons|strength|weakness|сравн|плюс|минус|сильн|слаб)/.test(value);
  const asksVerify = /(verify|check|prove|validate|test|провер|доказ|валид|тест)/.test(value);
  const asksResearch = /(research|source|evidence|investig|search|исслед|источник|доказательств|поиск)/.test(value);

  let desired = 1;
  if (isCyber) {
    desired = 3;
    add("security_analyst"); add("verifier"); add("researcher");
  } else if (isPhilosophy) {
    desired = asksCompare ? 3 : 2;
    add("researcher"); add("planner"); add("verifier");
  } else if (isCode) {
    desired = 2;
    add("programmer"); add("verifier"); add("researcher");
  } else if (isMath) {
    desired = asksVerify ? 2 : 1;
    add("mathematician"); add("verifier"); add("reporter");
  } else {
    add(classifyWorkRole(text));
    add("verifier");
    add("reporter");
  }

  if (asksCompare || asksResearch) desired = Math.max(desired, 2);
  if (String(text || "").length > 700) desired = Math.max(desired, 3);
  if (String(text || "").length > 1800) desired = Math.max(desired, 4);
  for (const role of requestedRoles) add(role);
  desired = Math.max(desired, Math.min(requestedRoles.length, 6));
  desired = Math.max(1, Math.min(6, desired));
  return { desired_workers: desired, suggested_roles: roles.slice(0, desired) };
}

function projectFinalText(sections) {
  return (sections || [])
    .filter((item) => typeof item?.content === "string" && item.content.trim())
    .map((item) => `#${item.sequence_no} ${item.role_name}\n${item.content.trim()}`)
    .join("\n\n");
}

function planProjectWork(text, requestedRoles = []) {
  const sourceText = String(text || "").trim();
  const profile = projectWorkerProfile(sourceText, requestedRoles);
  const blocks = splitProjectText(sourceText);
  const items = blocks.map((taskText, index) => ({
    sequence_no: index + 1,
    role_name: blocks.length === 1 && index === 0
      ? (profile.suggested_roles[0] || classifyWorkRole(taskText))
      : classifyWorkRole(taskText),
    task_text: taskText,
    role_source: "hub_recommended"
  }));

  const usedRoles = new Set(items.map((item) => item.role_name));
  const roleQueue = [...profile.suggested_roles, ...requestedRoles];
  for (const roleName of roleQueue) {
    if (items.length >= profile.desired_workers && requestedRoles.every((role) => usedRoles.has(role))) break;
    if (usedRoles.has(roleName)) continue;
    const prefix = roleName === "verifier"
      ? "Independently verify the reasoning and identify any errors or unsupported claims."
      : roleName === "researcher"
        ? "Analyze the question from an evidence/research perspective and identify relevant facts or assumptions."
        : roleName === "reporter"
          ? "Produce a concise synthesis suitable for the final project report."
          : `Analyze this task from the ${roleName} specialization.`;
    items.push({
      sequence_no: items.length + 1,
      role_name: roleName,
      task_text: `${prefix}\n\nOriginal task:\n${sourceText}`,
      role_source: requestedRoles.includes(roleName) ? "architect_added" : "hub_recommended"
    });
    usedRoles.add(roleName);
  }

  while (items.length < profile.desired_workers) {
    const roleName = profile.suggested_roles[items.length % Math.max(1, profile.suggested_roles.length)] || "planner";
    items.push({
      sequence_no: items.length + 1,
      role_name: roleName,
      task_text: `Provide an independent ${roleName} analysis of the original task.\n\nOriginal task:\n${sourceText}`,
      role_source: "hub_recommended"
    });
  }

  return items.map((item, index) => ({ ...item, sequence_no: index + 1 }));
}

function projectMissionId(workItemId) {
  return "mission_" + workItemId;
}

function projectAssignmentId(workItemId) {
  return "assignment_" + workItemId;
}

async function materializeProjectWorkForNode(env, nodeId, projectId = null) {
  await Promise.all([ensureProjectStorage(env), ensureNodeAiStorage(env)]);
  const node = await env.DB.prepare(`
    SELECT n.node_id, n.status, n.last_seen_at, n.capabilities_json,
      ai.installed, ai.loaded_model, ai.server_running
    FROM nodes AS n
    LEFT JOIN node_ai_state AS ai ON ai.node_id = n.node_id
    WHERE n.node_id = ?
  `).bind(nodeId).first();
  if (!node || node.status !== "online") return 0;
  const capabilities = safeJson(node.capabilities_json, []);
  const ready =
    Array.isArray(capabilities) &&
    capabilities.includes("project_text") &&
    Number(node.installed || 0) === 1 &&
    Number(node.server_running || 0) === 1 &&
    typeof node.loaded_model === "string" &&
    node.loaded_model.length > 0;
  if (!ready) return 0;

  const [planned, readyNodesQuery] = await Promise.all([
    env.DB.prepare(`
      SELECT w.work_item_id, w.project_id, w.sequence_no, w.role_name, w.task_text,
        w.node_id AS preferred_node_id, p.title AS project_title
      FROM project_work_items AS w
      JOIN architect_projects AS p ON p.project_id = w.project_id
      WHERE w.status = 'planned'
        AND p.status IN ('planned','running')
        AND (? IS NULL OR w.project_id = ?)
      ORDER BY CASE WHEN w.node_id = ? THEN 0 WHEN w.node_id IS NULL THEN 1 ELSE 2 END,
        datetime(p.created_at) ASC, w.sequence_no ASC
      LIMIT 32
    `).bind(projectId, projectId, nodeId).all(),
    env.DB.prepare(`
      SELECT n.node_id, n.capabilities_json, ai.installed, ai.loaded_model, ai.server_running
      FROM nodes AS n
      LEFT JOIN node_ai_state AS ai ON ai.node_id = n.node_id
      WHERE n.status = 'online'
        AND datetime(n.last_seen_at) >= datetime('now', '-5 minutes')
    `).all()
  ]);
  const readyNodeIds = new Set(
    (readyNodesQuery.results || [])
      .filter((candidate) => {
        const candidateCapabilities = safeJson(candidate.capabilities_json, []);
        return Array.isArray(candidateCapabilities) &&
          candidateCapabilities.includes("project_text") &&
          Number(candidate.installed || 0) === 1 &&
          Number(candidate.server_running || 0) === 1 &&
          typeof candidate.loaded_model === "string" &&
          candidate.loaded_model.length > 0;
      })
      .map((candidate) => candidate.node_id)
  );

  let created = 0;
  const candidates = (planned.results || []).filter((work) =>
    !work.preferred_node_id ||
    work.preferred_node_id === nodeId ||
    !readyNodeIds.has(work.preferred_node_id)
  ).slice(0, 2);
  for (const work of candidates) {
    const missionId = projectMissionId(work.work_item_id);
    const assignmentId = projectAssignmentId(work.work_item_id);
    const payloadJson = JSON.stringify({
      project_id: work.project_id,
      work_item_id: work.work_item_id,
      role_name: work.role_name,
      task_text: work.task_text
    });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE project_work_items
        SET node_id = ?, status = 'assigned', updated_at = CURRENT_TIMESTAMP
        WHERE work_item_id = ? AND status = 'planned'
      `).bind(nodeId, work.work_item_id),
      env.DB.prepare(`
        INSERT OR IGNORE INTO missions (
          mission_id, title, role_name, mission_type, payload_json,
          priority, status, expires_at
        )
        SELECT ?, ?, ?, 'project_text', ?, 40, 'assigned', ?
        WHERE EXISTS (
          SELECT 1 FROM project_work_items
          WHERE work_item_id = ? AND node_id = ? AND status = 'assigned'
        )
      `).bind(
        missionId,
        `Project: ${work.project_title} · block ${work.sequence_no}`,
        work.role_name,
        payloadJson,
        expiresAt,
        work.work_item_id,
        nodeId
      ),
      env.DB.prepare(`
        INSERT OR IGNORE INTO assignments (
          assignment_id, mission_id, node_id, status
        )
        SELECT ?, ?, ?, 'assigned'
        WHERE EXISTS (
          SELECT 1 FROM project_work_items
          WHERE work_item_id = ? AND node_id = ? AND status = 'assigned'
        )
      `).bind(assignmentId, missionId, nodeId, work.work_item_id, nodeId),
      env.DB.prepare(`
        UPDATE architect_projects
        SET status = 'running', updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ? AND status = 'planned'
          AND EXISTS (
            SELECT 1 FROM project_work_items
            WHERE work_item_id = ? AND node_id = ? AND status = 'assigned'
          )
      `).bind(work.project_id, work.work_item_id, nodeId),
      env.DB.prepare(`
        INSERT INTO audit_events (
          actor_type, actor_id, action, target_type, target_id, details_json
        )
        SELECT 'controller', 'project-scheduler', 'project.work.assigned',
          'project_work_item', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM assignments
          WHERE assignment_id = ? AND node_id = ?
        )
      `).bind(
        work.work_item_id,
        JSON.stringify({ project_id: work.project_id, node_id: nodeId, role_name: work.role_name }),
        assignmentId,
        nodeId
      )
    ]);
    if ((results[0]?.meta?.changes || 0) === 1) created += 1;
  }
  return created;
}

async function evaluateProjectChecks(env, sourceType, title, taskText) {
  await ensureProjectStorage(env);
  const sourceAllowed = sourceType === "architect_manual";
  const validationPass = title.length >= 1 && title.length <= 160 &&
    taskText.length >= 1 && taskText.length <= 20000;
  const taskSha256 = await sha256Hex(taskText);
  const duplicate = await env.DB.prepare(
    "SELECT project_id, status FROM architect_projects " +
    "WHERE task_sha256 = ? AND status IN ('planned','running') ORDER BY created_at DESC LIMIT 1"
  ).bind(taskSha256).first();
  const safety = projectSafetyClassification(taskText);
  return {
    task_sha256: taskSha256,
    checks: {
      source_allowlisting: {
        passed: sourceAllowed,
        detail: sourceAllowed ? "architect_manual_allowed" : "source_not_allowed"
      },
      validation: {
        passed: validationPass,
        detail: validationPass ? "input_valid" : "invalid_project_input"
      },
      deduplication: {
        passed: !duplicate,
        detail: duplicate ? "active_duplicate_found" : "no_active_duplicate",
        duplicate_project_id: duplicate?.project_id || null
      },
      safety_classification: {
        passed: safety.allowed,
        detail: safety.reason,
        classification: safety.classification
      }
    }
  };
}

function projectChecksPassed(checks) {
  return Object.values(checks).every((item) => item.passed === true);
}

async function architectCheckProject(request, env) {
  await authenticateArchitect(request, env);
  const body = parseJsonObject(await readBodyText(request, 64 * 1024));
  const sourceType = optionalString(body.source_type, "source_type", 40) || "architect_manual";
  const title = requireString(body.title, "title", 160);
  const taskText = requireString(body.task_text, "task_text", 20000);
  const requestedRoles = normalizeRequestedProjectRoles(body.requested_roles);
  const result = await evaluateProjectChecks(env, sourceType, title, taskText);
  const recommendedWork = planProjectWork(taskText);
  const plannedWork = planProjectWork(taskText, requestedRoles);
  const recommendedRolePlan = rolePlanSummary(recommendedWork);
  const selectedRolePlan = rolePlanSummary(plannedWork);
  return json({
    ok: true,
    ready_for_architect_approval: projectChecksPassed(result.checks),
    recommended_role_plan: recommendedRolePlan,
    recommended_roles: Object.keys(recommendedRolePlan),
    requested_roles: requestedRoles,
    selected_roles: Object.keys(selectedRolePlan),
    desired_workers: projectWorkerProfile(taskText, requestedRoles).desired_workers,
    role_plan: selectedRolePlan,
    work_preview: plannedWork.map(({ sequence_no, role_name, role_source }) => ({
      sequence_no,
      role_name,
      role_source
    })),
    ...result
  });
}

async function architectCreateProject(request, env) {
  await authenticateArchitect(request, env);
  const body = parseJsonObject(await readBodyText(request, 64 * 1024));
  const sourceType = optionalString(body.source_type, "source_type", 40) || "architect_manual";
  const title = requireString(body.title, "title", 160);
  const taskText = requireString(body.task_text, "task_text", 20000);
  const requestedRoles = normalizeRequestedProjectRoles(body.requested_roles);
  const evaluated = await evaluateProjectChecks(env, sourceType, title, taskText);
  if (!projectChecksPassed(evaluated.checks)) {
    throw new ApiError(409, "project_checks_failed");
  }

  await ensureNodeAiStorage(env);
  const nodesQuery = await env.DB.prepare(
    "SELECT n.node_id, n.hostname, n.agent_version, n.capabilities_json, nn.node_number, " +
    "ai.installed AS lmstudio_installed, ai.loaded_model AS lmstudio_loaded_model, " +
    "ai.server_running AS lmstudio_server_running " +
    "FROM nodes AS n " +
    "LEFT JOIN node_numbers AS nn ON nn.node_id = n.node_id " +
    "LEFT JOIN node_ai_state AS ai ON ai.node_id = n.node_id " +
    "WHERE n.status = 'online' AND datetime(n.last_seen_at) >= datetime('now', '-5 minutes') " +
    "ORDER BY n.last_seen_at DESC, n.node_id ASC"
  ).all();
  const onlineNodes = nodesQuery.results || [];
  if (!onlineNodes.length) throw new ApiError(409, "no_available_nodes");
  const nodes = onlineNodes.filter((node) => {
    const capabilities = safeJson(node.capabilities_json, []);
    return Array.isArray(capabilities) &&
      capabilities.includes("project_text") &&
      Number(node.lmstudio_installed || 0) === 1 &&
      Number(node.lmstudio_server_running || 0) === 1 &&
      typeof node.lmstudio_loaded_model === "string" &&
      node.lmstudio_loaded_model.length > 0;
  });

  const recommendedWork = planProjectWork(taskText);
  const recommendedRoles = new Set(recommendedWork.map((item) => item.role_name));
  const plannedWork = planProjectWork(taskText, requestedRoles);
  const workerCount = Math.min(nodes.length, plannedWork.length);
  const projectId = "project_" + crypto.randomUUID();
  const checksJson = JSON.stringify(evaluated.checks);
  const selectedRoleNames = [...new Set(plannedWork.map((item) => item.role_name))];
  const specializationSummary = selectedRoleNames.map((roleName) => ({
    ...roleMetadata(roleName),
    source: recommendedRoles.has(roleName) ? "hub_recommended" : "architect_added"
  }));
  const statements = [
    env.DB.prepare(
      "INSERT INTO architect_projects (" +
      "project_id, title, source_type, task_text, task_sha256, checks_json, architect_approved, status, worker_count" +
      ") VALUES (?, ?, ?, ?, ?, ?, 1, 'planned', ?)"
    ).bind(projectId, title, sourceType, taskText, evaluated.task_sha256, checksJson, workerCount),
    env.DB.prepare(
      "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
      "VALUES ('architect', 'test-console', 'project.created', 'project', ?, ?)"
    ).bind(projectId, JSON.stringify({
      worker_count: workerCount,
      work_items: plannedWork.length,
      roles: rolePlanSummary(plannedWork),
      requested_roles: requestedRoles
    }))
  ];
  for (const specialization of specializationSummary) {
    statements.push(env.DB.prepare(
      "INSERT INTO project_specializations (project_id, role_name, source) VALUES (?, ?, ?)"
    ).bind(projectId, specialization.id, specialization.source));
  }

  const workItems = [];
  for (let index = 0; index < plannedWork.length; index += 1) {
    const node = workerCount > 0 ? nodes[index % workerCount] : null;
    const planned = plannedWork[index];
    const workItemId = "work_" + crypto.randomUUID();
    workItems.push({
      work_item_id: workItemId,
      sequence_no: planned.sequence_no,
      role_name: planned.role_name,
      node_id: node?.node_id || null,
      hostname: node?.hostname || null,
      node_number: node?.node_number || null,
      task_text: planned.task_text,
      role_source: planned.role_source,
      status: "planned"
    });
    statements.push(
      env.DB.prepare(
        "INSERT INTO project_work_items (work_item_id, project_id, sequence_no, node_id, role_name, task_text, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'planned')"
      ).bind(workItemId, projectId, planned.sequence_no, node?.node_id || null, planned.role_name, planned.task_text)
    );
  }
  await env.DB.batch(statements);
  return json({
    ok: true,
    project: {
      project_id: projectId,
      title,
      status: "planned",
      architect_approved: true,
      worker_count: workerCount,
      desired_workers: projectWorkerProfile(taskText, requestedRoles).desired_workers,
      work_item_count: plannedWork.length,
      role_plan: rolePlanSummary(plannedWork),
      recommended_roles: [...recommendedRoles],
      requested_roles: requestedRoles,
      specializations: specializationSummary,
      checks: evaluated.checks,
      work_items: workItems
    },
    execution: {
      state: "planned",
      completed_work_items: 0,
      total_work_items: plannedWork.length,
      final_report_ready: false,
      detail: "hub_plan_created_waiting_for_project_worker_execution"
    }
  }, 201);
}

async function architectListProjects(request, env) {
  await authenticateArchitect(request, env);
  await ensureProjectStorage(env);
  const rows = await env.DB.prepare(
    "SELECT p.project_id, p.title, p.status, p.worker_count, p.created_at, p.updated_at, " +
    "(SELECT COUNT(*) FROM project_work_items AS w WHERE w.project_id = p.project_id) AS work_item_count, " +
    "(SELECT COUNT(*) FROM project_work_items AS w WHERE w.project_id = p.project_id AND w.status = 'completed') AS completed_work_items, " +
    "(SELECT COUNT(*) FROM project_work_items AS w WHERE w.project_id = p.project_id AND w.status = 'failed') AS failed_work_items, " +
    "(SELECT COUNT(*) FROM project_work_items AS w WHERE w.project_id = p.project_id AND w.status = 'assigned') AS assigned_work_items, " +
    "(SELECT COUNT(*) FROM project_work_items AS w WHERE w.project_id = p.project_id AND w.status = 'running') AS running_work_items, " +
    "(SELECT COUNT(*) FROM project_work_items AS w WHERE w.project_id = p.project_id AND w.status IN ('completed','failed','cancelled')) AS finished_work_items " +
    "FROM architect_projects AS p ORDER BY p.created_at DESC LIMIT 50"
  ).all();
  return json({ ok: true, projects: rows.results || [] });
}

async function architectGetProject(request, env, projectId) {
  await authenticateArchitect(request, env);
  await Promise.all([ensureProjectStorage(env), ensureNodeAiStorage(env), ensureReportStorage(env)]);
  const project = await env.DB.prepare(`
    SELECT project_id, title, source_type, task_text, checks_json,
      architect_approved, status, worker_count, created_at, updated_at
    FROM architect_projects
    WHERE project_id = ?
  `).bind(projectId).first();
  if (!project) throw new ApiError(404, "project_not_found");

  const readinessQuery = await env.DB.prepare(`
    SELECT
      n.node_id, n.hostname, n.agent_version, n.status, n.last_seen_at, n.capabilities_json,
      nn.node_number,
      CASE WHEN n.status = 'online'
        AND datetime(n.last_seen_at) >= datetime('now', '-5 minutes')
        THEN 1 ELSE 0 END AS recently_seen,
      ai.installed AS lmstudio_installed,
      ai.loaded_model AS lmstudio_loaded_model,
      ai.server_running AS lmstudio_server_running
    FROM nodes AS n
    LEFT JOIN node_numbers AS nn ON nn.node_id = n.node_id
    LEFT JOIN node_ai_state AS ai ON ai.node_id = n.node_id
    WHERE n.status != 'revoked'
    ORDER BY recently_seen DESC, n.last_seen_at DESC, nn.node_number ASC
    LIMIT 100
  `).all();

  const workerReadiness = (readinessQuery.results || []).map((node) => {
    const capabilities = safeJson(node.capabilities_json, []);
    const hasProjectText = Array.isArray(capabilities) && capabilities.includes("project_text");
    const live = Number(node.recently_seen || 0) === 1;
    const installed = Number(node.lmstudio_installed || 0) === 1;
    const serverRunning = Number(node.lmstudio_server_running || 0) === 1;
    const loadedModel = typeof node.lmstudio_loaded_model === "string" && node.lmstudio_loaded_model.length > 0;
    const blockers = [];
    if (!live) blockers.push("offline");
    if (!hasProjectText) blockers.push(
      node.agent_version !== LATEST_NODE_RELEASE.version ? "agent_outdated" : "project_text_missing"
    );
    if (!installed) blockers.push("lmstudio_not_installed");
    else {
      if (!serverRunning) blockers.push("lmstudio_server_stopped");
      if (!loadedModel) blockers.push("lmstudio_model_not_loaded");
    }
    return {
      node_id: node.node_id,
      node_number: node.node_number || null,
      hostname: node.hostname || null,
      agent_version: node.agent_version || null,
      live,
      project_text: hasProjectText,
      lmstudio_installed: installed,
      lmstudio_server_running: serverRunning,
      lmstudio_loaded_model: node.lmstudio_loaded_model || null,
      ready: blockers.length === 0,
      blockers
    };
  });

  const readyWorkers = workerReadiness.filter((node) => node.ready);
  if (project.status === "planned" || project.status === "running") {
    for (const worker of readyWorkers.slice(0, 6)) {
      await materializeProjectWorkForNode(env, worker.node_id, projectId);
    }
  }

  const [workQuery, specializationQuery] = await Promise.all([
    env.DB.prepare(`
      SELECT
        w.work_item_id, w.sequence_no, w.role_name, w.task_text, w.status,
        w.created_at, w.updated_at, w.node_id,
        n.hostname, n.agent_version, nn.node_number,
        ai.installed AS lmstudio_installed,
        ai.loaded_model AS lmstudio_loaded_model,
        ai.server_running AS lmstudio_server_running,
        (
          SELECT r.summary FROM results AS r
          WHERE r.assignment_id = ('assignment_' || w.work_item_id)
          LIMIT 1
        ) AS result_summary,
        (
          SELECT ar.report_json FROM agent_reports AS ar
          WHERE ar.assignment_id = ('assignment_' || w.work_item_id)
          ORDER BY datetime(ar.created_at) DESC LIMIT 1
        ) AS result_json
      FROM project_work_items AS w
      LEFT JOIN nodes AS n ON n.node_id = w.node_id
      LEFT JOIN node_numbers AS nn ON nn.node_id = w.node_id
      LEFT JOIN node_ai_state AS ai ON ai.node_id = w.node_id
      WHERE w.project_id = ?
      ORDER BY w.sequence_no ASC, w.work_item_id ASC
    `).bind(projectId).all(),
    env.DB.prepare(`
      SELECT role_name, source, created_at
      FROM project_specializations
      WHERE project_id = ?
      ORDER BY created_at ASC, role_name ASC
    `).bind(projectId).all()
  ]);

  const workItems = (workQuery.results || []).map((item) => ({
    ...item,
    result: safeJson(item.result_json, null),
    result_json: undefined
  }));
  let specializationRows = specializationQuery.results || [];
  if (!specializationRows.length) {
    specializationRows = [...new Set(workItems.map((item) => item.role_name))].map((roleName) => ({
      role_name: roleName,
      source: "hub_recommended",
      created_at: project.created_at
    }));
  }
  const specializations = specializationRows.map((item) => ({
    ...roleMetadata(item.role_name),
    source: item.source,
    created_at: item.created_at
  }));

  const counts = {
    planned: 0,
    assigned: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0
  };
  for (const item of workItems) {
    if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
  }
  const total = workItems.length;
  const finished = counts.completed + counts.failed + counts.cancelled;
  const executionState = total > 0 && finished === total
    ? counts.failed > 0 ? "completed_with_failures" : "completed"
    : counts.running > 0
      ? "running"
      : counts.assigned > 0
        ? "assigned"
        : "planned";
  const finalSections = workItems
    .filter((item) => item.result && typeof item.result === "object")
    .map((item) => ({
      sequence_no: item.sequence_no,
      role_name: item.role_name,
      node_id: item.node_id,
      model: item.result.model || null,
      content: typeof item.result.content === "string" ? item.result.content : null,
      status: item.status
    }));
  const workComplete = total > 0 && finished === total;
  const rawResultText = workComplete ? projectFinalText(finalSections) : null;
  const qualityGate = workComplete
    ? await finalizeProjectAnswer(env, project.project_id, project.task_text, rawResultText)
    : {
        ready: false,
        status: "waiting_for_workers",
        content: null,
        reviewed: false,
        model: null,
        error_code: null
      };
  const finalReportReady = workComplete && qualityGate.ready;
  const finalResultText = finalReportReady ? qualityGate.content : null;
  return json({
    ok: true,
    project: {
      ...project,
      checks: safeJson(project.checks_json, {}),
      checks_json: undefined,
      role_plan: rolePlanSummary(workItems),
      specializations,
      work_items: workItems,
      execution: {
        state: executionState,
        counts,
        desired_workers: projectWorkerProfile(project.task_text, specializations.filter((item) => item.source === "architect_added").map((item) => item.id)).desired_workers,
        ready_workers_at_creation: Number(project.worker_count || 0),
        ready_workers_now: readyWorkers.length,
        worker_readiness: workerReadiness,
        completed_work_items: counts.completed,
        total_work_items: total,
        final_report_ready: finalReportReady,
        progress_percent: total ? Math.round((finished / total) * 100) : 0,
        detail: workComplete && !finalReportReady
          ? "final_quality_gate_running"
          : finalReportReady && qualityGate.reviewed
            ? "final_quality_gate_completed"
            : finalReportReady && qualityGate.status === "degraded"
              ? "final_quality_gate_degraded"
              : executionState === "planned"
                ? "waiting_for_lmstudio_project_worker"
                : executionState === "completed"
                  ? "all_project_work_items_completed"
                  : executionState
      },
      final_report: {
        ready: finalReportReady,
        sections: finalSections,
        combined_text: finalResultText,
        quality_gate: {
          status: qualityGate.status,
          reviewed: qualityGate.reviewed,
          model: qualityGate.model,
          error_code: qualityGate.error_code
        }
      }
    }
  });
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256Hex(value) {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(digest);
}

function controllerCommandCanonical(commandId, nodeId, commandType, payloadHash, createdAt) {
  return [
    "CITADEL-COMMAND-V1",
    commandId,
    nodeId,
    commandType,
    payloadHash,
    createdAt
  ].join("\n");
}

function controllerPrivateJwk(env) {
  let encodedKey = typeof env.CONTROLLER_COMMAND_PRIVATE_JWK === "string"
    ? env.CONTROLLER_COMMAND_PRIVATE_JWK.trim()
    : "";

  if (encodedKey.startsWith("```")) {
    encodedKey = encodedKey
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }

  let privateJwk;
  try {
    privateJwk = JSON.parse(encodedKey);
    if (typeof privateJwk === "string") {
      privateJwk = JSON.parse(privateJwk.trim());
    }
  } catch {
    throw new ApiError(503, "controller_signing_not_configured");
  }

  if (
    !privateJwk ||
    privateJwk.kty !== "OKP" ||
    privateJwk.crv !== "Ed25519" ||
    privateJwk.x !== CONTROLLER_COMMAND_PUBLIC_X ||
    typeof privateJwk.d !== "string"
  ) {
    throw new ApiError(503, "controller_signing_not_configured");
  }

  return {
    kty: "OKP",
    crv: "Ed25519",
    x: privateJwk.x,
    d: privateJwk.d
  };
}

async function importControllerPrivateKey(env) {
  const privateJwk = controllerPrivateJwk(env);
  const algorithms = [
    { name: "Ed25519" },
    { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }
  ];

  for (const algorithm of algorithms) {
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        privateJwk,
        algorithm,
        false,
        ["sign"]
      );
      return { key, algorithm };
    } catch {
      // Try Cloudflare's legacy Ed25519 name after the web-standard name.
    }
  }

  throw new ApiError(503, "controller_signing_not_configured");
}

async function signControllerCommand(env, commandId, nodeId, commandType, payloadJson, createdAt) {
  try {
    const { key, algorithm } = await importControllerPrivateKey(env);
    const payloadHash = await sha256Hex(payloadJson);
    const canonical = controllerCommandCanonical(
      commandId,
      nodeId,
      commandType,
      payloadHash,
      createdAt
    );
    const signature = await crypto.subtle.sign(
      algorithm,
      key,
      new TextEncoder().encode(canonical)
    );
    return bytesToBase64Url(signature);
  } catch {
    throw new ApiError(503, "controller_signing_not_configured");
  }
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError(401, "invalid_signature");
  }

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let decoded;
  try {
    decoded = atob(padded);
  } catch {
    throw new ApiError(401, "invalid_signature");
  }

  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function normalizePublicKey(value) {
  let jwk = value;
  if (typeof jwk === "string") {
    try {
      jwk = JSON.parse(jwk);
    } catch {
      throw new ApiError(400, "invalid_public_key");
    }
  }

  if (
    !jwk ||
    typeof jwk !== "object" ||
    Array.isArray(jwk) ||
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    "d" in jwk
  ) {
    throw new ApiError(400, "invalid_public_key");
  }

  let rawKey;
  try {
    rawKey = decodeBase64Url(jwk.x);
  } catch {
    throw new ApiError(400, "invalid_public_key");
  }
  if (rawKey.byteLength !== 32) {
    throw new ApiError(400, "invalid_public_key");
  }

  const canonicalX = bytesToBase64Url(rawKey);
  return JSON.stringify({ kty: "OKP", crv: "Ed25519", x: canonicalX });
}

function normalizeCapabilities(value) {
  if (value === undefined || value === null) {
    return "[]";
  }
  if (!Array.isArray(value) || value.length > 32) {
    throw new ApiError(400, "invalid_capabilities");
  }

  const capabilities = [...new Set(value.map((item) =>
    requireString(item, "capabilities", 64)
  ))];
  return JSON.stringify(capabilities);
}

function normalizeLmModelId(value) {
  const model = requireString(value, "lmstudio_model", 192);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/.test(model)) {
    throw new ApiError(400, "invalid_lmstudio_model");
  }
  return model;
}

function normalizeLmQuantization(value) {
  if (value === undefined || value === null || value === "") return null;
  const quantization = requireString(value, "lmstudio_quantization", 32);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(quantization)) {
    throw new ApiError(400, "invalid_lmstudio_quantization");
  }
  return quantization;
}

function normalizeLmLoadSettings(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_lmstudio_settings");
  }
  const allowed = new Set(["context_length", "flash_attention", "offload_kv_cache_to_gpu", "num_experts"]);
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) throw new ApiError(400, "invalid_lmstudio_setting");
    if (key === "context_length") {
      if (!Number.isInteger(raw) || raw < 256 || raw > 1048576) throw new ApiError(400, "invalid_context_length");
    } else if (key === "num_experts") {
      if (!Number.isInteger(raw) || raw < 1 || raw > 256) throw new ApiError(400, "invalid_num_experts");
    } else if (typeof raw !== "boolean") {
      throw new ApiError(400, "invalid_lmstudio_boolean_setting");
    }
    out[key] = raw;
  }
  return out;
}

function normalizeHybridSettings(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_hybrid_settings");
  const allowed = new Set(["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "max_output_tokens", "reasoning", "context_length"]);
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) throw new ApiError(400, "invalid_hybrid_setting");
    if (["temperature", "top_p", "min_p"].includes(key)) {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) throw new ApiError(400, "invalid_hybrid_float");
    } else if (key === "top_k") {
      if (!Number.isInteger(raw) || raw < 0 || raw > 1000) throw new ApiError(400, "invalid_top_k");
    } else if (key === "repeat_penalty") {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0.5 || raw > 2) throw new ApiError(400, "invalid_repeat_penalty");
    } else if (key === "max_output_tokens") {
      if (!Number.isInteger(raw) || raw < 1 || raw > 32768) throw new ApiError(400, "invalid_max_output_tokens");
    } else if (key === "context_length") {
      if (!Number.isInteger(raw) || raw < 256 || raw > 1048576) throw new ApiError(400, "invalid_context_length");
    } else if (key === "reasoning" && !["off","low","medium","high","on"].includes(raw)) {
      throw new ApiError(400, "invalid_reasoning");
    }
    out[key] = raw;
  }
  return out;
}

function normalizeAiState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_ai_state");
  const strings = [
    ["selected_model", 192], ["loaded_model", 192], ["last_action", 96],
    ["progress_phase", 96], ["progress_detail", 512], ["download_job_id", 160],
    ["query_id", 160], ["query_mode", 32], ["query_status", 32],
    ["query_prompt", 8000], ["query_answer", 65536], ["live_checked_at", 64]
  ];
  const out = {
    installed: value.installed === true || value.installed === 1 ? 1 : 0,
    server_running: value.server_running === true || value.server_running === 1 ? 1 : 0
  };
  for (const [name, max] of strings) {
    const raw = value[name];
    if (raw === undefined || raw === null || raw === "") out[name] = null;
    else if (typeof raw !== "string" || raw.length > max) throw new ApiError(400, "invalid_ai_state");
    else out[name] = raw;
  }
  for (const name of ["progress_current","progress_total","progress_bytes","progress_total_bytes"]) {
    const raw = value[name];
    if (raw === undefined || raw === null) out[name] = null;
    else if (!Number.isSafeInteger(raw) || raw < 0) throw new ApiError(400, "invalid_ai_state");
    else out[name] = raw;
  }
  const loadConfig = value.load_config && typeof value.load_config === "object" && !Array.isArray(value.load_config)
    ? value.load_config : null;
  if (loadConfig) {
    const serialized = JSON.stringify(loadConfig);
    if (new TextEncoder().encode(serialized).byteLength > 8192) throw new ApiError(400, "ai_load_config_too_large");
  }
  out.load_config = loadConfig;
  return out;
}

function normalizeMetrics(value) {
  if (value === undefined || value === null) {
    return "{}";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_metrics");
  }

  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 16 * 1024) {
    throw new ApiError(400, "invalid_metrics");
  }
  return serialized;
}

async function authenticateNode(request, env, nodeId, url, bodyBytes) {
  const headerNodeId = request.headers.get("x-node-id");
  const timestamp = request.headers.get("x-node-timestamp");
  const requestId = request.headers.get("x-node-request-id");
  const signatureValue = request.headers.get("x-node-signature");

  if (!headerNodeId || headerNodeId !== nodeId || !timestamp || !signatureValue) {
    throw new ApiError(401, "node_authentication_required");
  }
  if (!/^\d{10,13}$/.test(timestamp)) {
    throw new ApiError(401, "invalid_timestamp");
  }
  if (requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
    throw new ApiError(401, "invalid_request_id");
  }

  const numericTimestamp = Number(timestamp);
  const timestampSeconds = timestamp.length === 13
    ? Math.floor(numericTimestamp / 1000)
    : numericTimestamp;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_WINDOW_SECONDS) {
    throw new ApiError(401, "expired_signature");
  }

  const node = await env.DB.prepare(
    "SELECT node_id, public_key, status, agent_version FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();
  if (!node) throw new ApiError(401, "invalid_node");
  if (node.status === "revoked") throw new ApiError(403, "node_revoked");

  const replayProtected = agentRequiresRequestId(node.agent_version);
  if (replayProtected && !requestId) {
    throw new ApiError(401, "request_id_required");
  }

  let publicJwk;
  try {
    publicJwk = JSON.parse(node.public_key);
  } catch {
    throw new ApiError(401, "invalid_node_key");
  }

  const bodyHash = await sha256Hex(bodyBytes);
  const canonicalParts = [
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    timestamp
  ];
  if (requestId) canonicalParts.push(requestId);
  canonicalParts.push(bodyHash);
  const canonicalRequest = canonicalParts.join("\n");

  let verified = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk", publicJwk, { name: "Ed25519" }, false, ["verify"]
    );
    const signature = decodeBase64Url(signatureValue);
    verified = signature.byteLength === 64 && await crypto.subtle.verify(
      "Ed25519", key, signature, new TextEncoder().encode(canonicalRequest)
    );
  } catch {
    verified = false;
  }
  if (!verified) throw new ApiError(401, "invalid_signature");

  if (requestId) {
    await ensureNodeRequestNonceStorage(env);
    const nonce = await env.DB.prepare(
      "INSERT OR IGNORE INTO node_request_nonces (node_id, request_id) VALUES (?, ?)"
    ).bind(nodeId, requestId).run();
    if ((nonce?.meta?.changes || 0) !== 1) {
      throw new ApiError(409, "replayed_request");
    }
    await env.DB.prepare(
      "DELETE FROM node_request_nonces WHERE datetime(received_at) < datetime('now', '-10 minutes')"
    ).run();
  }
  return node;
}

function autoEnrollmentLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

async function ensureAutoEnrollmentStorage(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS node_numbers (
        node_number INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
      )
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_node_numbers_public_key
      ON node_numbers(public_key)
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS auto_enrollment_windows (
        window_key TEXT PRIMARY KEY,
        created_count INTEGER NOT NULL DEFAULT 0 CHECK (created_count >= 0),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
  ]);
}

async function consumeAutoEnrollmentSlot(env) {
  const hourlyLimit = autoEnrollmentLimit(
    env.AUTO_ENROLL_MAX_NEW_PER_HOUR,
    AUTO_ENROLLMENT_DEFAULT_HOURLY_LIMIT,
    100000
  );
  const nodeCap = autoEnrollmentLimit(
    env.AUTO_ENROLL_MAX_NODES,
    AUTO_ENROLLMENT_DEFAULT_NODE_CAP,
    1000000
  );
  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM nodes"
  ).first();
  if (Number(total?.count || 0) >= nodeCap) {
    throw new ApiError(503, "auto_enrollment_capacity_reached");
  }

  const now = new Date();
  const windowKey = now.toISOString().slice(0, 13);
  const pruneBefore = new Date(now.getTime() - 48 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 13);
  await env.DB.prepare(
    "DELETE FROM auto_enrollment_windows WHERE window_key < ?"
  ).bind(pruneBefore).run();

  const slot = await env.DB.prepare(`
    INSERT INTO auto_enrollment_windows (window_key, created_count, updated_at)
    VALUES (?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(window_key) DO UPDATE SET
      created_count = auto_enrollment_windows.created_count + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE auto_enrollment_windows.created_count < ?
    RETURNING created_count
  `).bind(windowKey, hourlyLimit).first();
  if (!slot) {
    throw new ApiError(429, "auto_enrollment_rate_limited");
  }
}

function enrollmentResponse(nodeId, nodeNumber, status = "online", responseStatus = 201) {
  return json({
    ok: true,
    node: { node_id: nodeId, node_number: nodeNumber, status },
    authentication: {
      scheme: "CITADEL-Ed25519",
      required_headers: ["x-node-id", "x-node-timestamp", "x-node-request-id", "x-node-signature"],
      signature_window_seconds: SIGNATURE_WINDOW_SECONDS
    }
  }, responseStatus);
}

async function enrollNode(request, env) {
  const bodyText = await readBodyText(request, MAX_ENROLLMENT_BODY_BYTES);
  const body = parseJsonObject(bodyText);

  const publicKey = normalizePublicKey(body.public_key);
  const hostname = requireString(body.hostname, "hostname", 255);
  const osName = requireString(body.os_name, "os_name", 80);
  const osVersion = optionalString(body.os_version, "os_version", 80);
  const architecture = optionalString(body.architecture, "architecture", 80);
  const agentVersion = requireString(body.agent_version, "agent_version", 80);
  const capabilitiesJson = normalizeCapabilities(body.capabilities);
  const detailsJson = JSON.stringify({
    hostname,
    os_name: osName,
    agent_version: agentVersion,
    enrollment: "automatic"
  });

  await ensureAutoEnrollmentStorage(env);

  let existing = await env.DB.prepare(`
    SELECT n.node_id, n.status, nn.node_number
    FROM node_numbers AS nn
    JOIN nodes AS n ON n.node_id = nn.node_id
    WHERE nn.public_key = ?
  `).bind(publicKey).first();
  if (existing) {
    if (existing.status === "revoked") {
      throw new ApiError(403, "node_revoked");
    }
    return enrollmentResponse(existing.node_id, existing.node_number, existing.status, 200);
  }

  const legacyNode = await env.DB.prepare(`
    SELECT node_id, status
    FROM nodes
    WHERE public_key = ?
  `).bind(publicKey).first();
  if (legacyNode) {
    if (legacyNode.status === "revoked") {
      throw new ApiError(403, "node_revoked");
    }
    await env.DB.prepare(`
      INSERT OR IGNORE INTO node_numbers (node_id, public_key)
      VALUES (?, ?)
    `).bind(legacyNode.node_id, publicKey).run();
    existing = await env.DB.prepare(`
      SELECT n.node_id, n.status, nn.node_number
      FROM node_numbers AS nn
      JOIN nodes AS n ON n.node_id = nn.node_id
      WHERE nn.public_key = ?
    `).bind(publicKey).first();
    if (!existing?.node_number) {
      throw new ApiError(500, "node_number_assignment_failed");
    }
    return enrollmentResponse(existing.node_id, existing.node_number, existing.status, 200);
  }

  await consumeAutoEnrollmentSlot(env);

  const nodeId = `node_${crypto.randomUUID()}`;
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO nodes (
          node_id, public_key, hostname, os_name, os_version,
          architecture, agent_version, status, capabilities_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?)
      `).bind(nodeId, publicKey, hostname, osName, osVersion, architecture, agentVersion, capabilitiesJson),
      env.DB.prepare(`
        INSERT INTO node_numbers (node_id, public_key)
        VALUES (?, ?)
      `).bind(nodeId, publicKey),
      env.DB.prepare(`
        INSERT INTO audit_events (
          actor_type, actor_id, action, target_type, target_id, details_json
        ) VALUES ('node', ?, 'node.auto_enrolled', 'node', ?, ?)
      `).bind(nodeId, nodeId, detailsJson)
    ]);
  } catch (error) {
    if (String(error).includes("public_key") || String(error).includes("UNIQUE")) {
      const raced = await env.DB.prepare(`
        SELECT n.node_id, n.status, nn.node_number
        FROM node_numbers AS nn
        JOIN nodes AS n ON n.node_id = nn.node_id
        WHERE nn.public_key = ?
      `).bind(publicKey).first();
      if (raced) {
        if (raced.status === "revoked") {
          throw new ApiError(403, "node_revoked");
        }
        return enrollmentResponse(raced.node_id, raced.node_number, raced.status, 200);
      }
    }
    throw error;
  }

  const assigned = await env.DB.prepare(
    "SELECT node_number FROM node_numbers WHERE node_id = ?"
  ).bind(nodeId).first();
  if (!assigned?.node_number) {
    throw new ApiError(500, "node_number_assignment_failed");
  }
  return enrollmentResponse(nodeId, assigned.node_number);
}

async function heartbeat(request, env, nodeId, url) {
  const { bytes: bodyBytes, text: bodyText } = await readBody(request, MAX_NODE_BODY_BYTES);
  await authenticateNode(request, env, nodeId, url, bodyBytes);
  const body = parseJsonObject(bodyText);

  const cpuPercent = optionalPercent(body.cpu_percent, "cpu_percent");
  const memoryPercent = optionalPercent(body.memory_percent, "memory_percent");
  const agentVersion = optionalString(body.agent_version, "agent_version", 80);
  const capabilitiesJson = body.capabilities === undefined
    ? null
    : normalizeCapabilities(body.capabilities);
  const network = normalizeNodeNetwork(body.network);
  if (network) await ensureNodeNetworkStorage(env);
  const detailsJson = JSON.stringify({
    cpu_percent: cpuPercent,
    memory_percent: memoryPercent,
    agent_version: agentVersion,
    lan_ipv4: network?.lan_ipv4 || null
  });

  const heartbeatStatements = [
    env.DB.prepare(`
      UPDATE nodes
      SET cpu_percent = COALESCE(?, cpu_percent),
          memory_percent = COALESCE(?, memory_percent),
          agent_version = COALESCE(?, agent_version),
          capabilities_json = COALESCE(?, capabilities_json),
          status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'online' END,
          last_seen_at = CURRENT_TIMESTAMP
      WHERE node_id = ? AND status != 'revoked'
    `).bind(cpuPercent, memoryPercent, agentVersion, capabilitiesJson, nodeId),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      )
      SELECT 'node', ?, 'node.heartbeat', 'node', ?, ?
      WHERE changes() = 1
    `).bind(nodeId, nodeId, detailsJson)
  ];
  if (network) {
    heartbeatStatements.push(env.DB.prepare(`
      INSERT INTO node_network_state (
        node_id, lan_ipv4, tailscale_ipv4, mac_addresses_json, updated_at
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(node_id) DO UPDATE SET
        lan_ipv4 = COALESCE(excluded.lan_ipv4, node_network_state.lan_ipv4),
        tailscale_ipv4 = COALESCE(excluded.tailscale_ipv4, node_network_state.tailscale_ipv4),
        mac_addresses_json = CASE
          WHEN excluded.mac_addresses_json != '[]' THEN excluded.mac_addresses_json
          ELSE node_network_state.mac_addresses_json
        END,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      nodeId,
      network.lan_ipv4,
      network.tailscale_ipv4,
      JSON.stringify(network.mac_addresses)
    ));
  }
  const results = await env.DB.batch(heartbeatStatements);

  if ((results[0]?.meta?.changes || 0) !== 1) {
    throw new ApiError(404, "node_not_found");
  }

  const node = await env.DB.prepare(
    "SELECT status, last_seen_at FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();
  return json({ ok: true, node_id: nodeId, ...node });
}

async function listAssignments(request, env, nodeId, url) {
  const node = await authenticateNode(request, env, nodeId, url, new Uint8Array(0));

  if (node.status === "paused") {
    return json({ ok: true, node_status: "paused", assignments: [] });
  }

  await materializeProjectWorkForNode(env, nodeId);

  const query = await env.DB.prepare(`
    SELECT
      a.assignment_id,
      a.mission_id,
      a.status,
      a.assigned_at,
      a.started_at,
      a.attempt_count,
      m.title,
      m.role_name,
      m.mission_type,
      m.payload_json,
      m.priority,
      m.expires_at
    FROM assignments AS a
    JOIN missions AS m ON m.mission_id = a.mission_id
    WHERE a.node_id = ?
      AND a.status IN ('assigned', 'running')
      AND m.status != 'cancelled'
      AND (m.expires_at IS NULL OR datetime(m.expires_at) > CURRENT_TIMESTAMP)
    ORDER BY m.priority ASC, a.assigned_at ASC
    LIMIT 20
  `).bind(nodeId).all();

  const assignments = (query.results || []).map((row) => ({
    ...row,
    payload: safeJson(row.payload_json, {}),
    payload_json: undefined
  }));
  return json({ ok: true, node_status: node.status, assignments });
}

async function acceptAssignment(request, env, nodeId, assignmentId, url) {
  const { bytes: bodyBytes, text: bodyText } = await readBody(request, 1024);
  const node = await authenticateNode(request, env, nodeId, url, bodyBytes);
  if (node.status === "paused") {
    throw new ApiError(409, "node_paused");
  }

  const acceptResults = await env.DB.batch([
    env.DB.prepare(`
      UPDATE assignments
      SET status = 'running',
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          attempt_count = attempt_count + 1
      WHERE assignment_id = ?
        AND node_id = ?
        AND status = 'assigned'
        AND EXISTS (
          SELECT 1
          FROM missions
          WHERE missions.mission_id = assignments.mission_id
            AND missions.status != 'cancelled'
            AND (missions.expires_at IS NULL OR datetime(missions.expires_at) > CURRENT_TIMESTAMP)
        )
        AND EXISTS (
          SELECT 1
          FROM nodes
          WHERE nodes.node_id = assignments.node_id
            AND nodes.status NOT IN ('paused', 'revoked')
        )
    `).bind(assignmentId, nodeId),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      )
      SELECT 'node', ?, 'assignment.accepted', 'assignment', ?, '{}'
      WHERE changes() = 1
    `).bind(nodeId, assignmentId),
    env.DB.prepare(`
      UPDATE project_work_items
      SET status = 'running', updated_at = CURRENT_TIMESTAMP
      WHERE ('assignment_' || work_item_id) = ?
        AND node_id = ?
        AND status = 'assigned'
    `).bind(assignmentId, nodeId),
    env.DB.prepare(`
      UPDATE architect_projects
      SET status = 'running', updated_at = CURRENT_TIMESTAMP
      WHERE project_id = (
        SELECT project_id FROM project_work_items
        WHERE ('assignment_' || work_item_id) = ?
        LIMIT 1
      )
        AND status IN ('planned','running')
    `).bind(assignmentId)
  ]);

  const assignment = await env.DB.prepare(`
    SELECT assignment_id, mission_id, status, started_at, attempt_count
    FROM assignments
    WHERE assignment_id = ? AND node_id = ?
  `).bind(assignmentId, nodeId).first();

  if (!assignment) {
    throw new ApiError(404, "assignment_not_found");
  }
  if ((acceptResults[0]?.meta?.changes || 0) === 0 && assignment.status === "assigned") {
    const currentNode = await env.DB.prepare(
      "SELECT status FROM nodes WHERE node_id = ?"
    ).bind(nodeId).first();
    if (currentNode?.status === "paused") {
      throw new ApiError(409, "node_paused");
    }
    if (currentNode?.status === "revoked") {
      throw new ApiError(403, "node_revoked");
    }
  }
  if (assignment.status !== "running") {
    throw new ApiError(409, "assignment_not_active");
  }
  return json({ ok: true, assignment });
}

async function submitResult(request, env, nodeId, url) {
  const { bytes: bodyBytes, text: bodyText } = await readBody(request, MAX_RESULT_BODY_BYTES);
  await authenticateNode(request, env, nodeId, url, bodyBytes);
  const body = parseJsonObject(bodyText);

  const assignmentId = requireString(body.assignment_id, "assignment_id", 128);
  const outcome = requireString(body.outcome, "outcome", 16);
  if (!ALLOWED_OUTCOMES.has(outcome)) {
    throw new ApiError(400, "invalid_outcome");
  }

  const summary = optionalString(body.summary, "summary", 4000);
  const artifactKey = optionalString(body.artifact_key, "artifact_key", 512);
  const metricsJson = normalizeMetrics(body.metrics);
  const reportType = body.report_type === undefined
    ? "mission_result"
    : requireString(body.report_type, "report_type", 64);
  const sensitivity = body.sensitivity === undefined
    ? "internal"
    : requireString(body.sensitivity, "sensitivity", 32);
  if (!ALLOWED_REPORT_SENSITIVITIES.has(sensitivity)) {
    throw new ApiError(400, "invalid_sensitivity");
  }

  const reportValue = body.report === undefined
    ? {
        summary,
        artifact_key: artifactKey,
        metrics: safeJson(metricsJson, {})
      }
    : body.report;
  const reportJson = JSON.stringify(reportValue);
  const reportSizeBytes = new TextEncoder().encode(reportJson).byteLength;
  if (reportSizeBytes > MAX_REPORT_BYTES) {
    throw new ApiError(413, "report_too_large");
  }
  const reportSha256 = await sha256Hex(reportJson);
  await ensureReportStorage(env);

  const existing = await env.DB.prepare(`
    SELECT result_id, outcome, created_at
    FROM results
    WHERE assignment_id = ? AND node_id = ?
  `).bind(assignmentId, nodeId).first();
  if (existing) {
    return json({ ok: true, duplicate: true, result: existing });
  }

  const resultId = `result_${crypto.randomUUID()}`;
  const reportId = `report_${crypto.randomUUID()}`;
  const assignmentStatus = outcome === "failed" ? "failed" : "completed";
  const detailsJson = JSON.stringify({ result_id: resultId, outcome });

  const isProjectAssignment = assignmentId.startsWith("assignment_work_");
  if (isProjectAssignment) await ensureProjectStorage(env);

  const resultStatements = [
    env.DB.prepare(`
      INSERT INTO results (
        result_id, assignment_id, node_id, outcome,
        summary, artifact_key, metrics_json
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      FROM assignments
      WHERE assignment_id = ?
        AND node_id = ?
        AND status IN ('assigned', 'running')
    `).bind(
      resultId,
      assignmentId,
      nodeId,
      outcome,
      summary,
      artifactKey,
      metricsJson,
      assignmentId,
      nodeId
    ),
    env.DB.prepare(`
      INSERT INTO agent_reports (
        report_id, result_id, assignment_id, mission_id, node_id,
        report_type, report_json, report_sha256,
        report_size_bytes, sensitivity
      )
      SELECT ?, r.result_id, r.assignment_id, a.mission_id, r.node_id,
             ?, ?, ?, ?, ?
      FROM results AS r
      JOIN assignments AS a ON a.assignment_id = r.assignment_id
      WHERE r.result_id = ?
    `).bind(
      reportId,
      reportType,
      reportJson,
      reportSha256,
      reportSizeBytes,
      sensitivity,
      resultId
    ),
    env.DB.prepare(`
      UPDATE assignments
      SET status = ?,
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          completed_at = CURRENT_TIMESTAMP
      WHERE assignment_id = ? AND node_id = ? AND changes() = 1
    `).bind(assignmentStatus, assignmentId, nodeId)
  ];

  if (isProjectAssignment) {
    resultStatements.push(
      env.DB.prepare(`
        UPDATE project_work_items
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE ('assignment_' || work_item_id) = ?
          AND node_id = ?
          AND status IN ('assigned','running')
          AND EXISTS (SELECT 1 FROM results WHERE result_id = ?)
      `).bind(assignmentStatus, assignmentId, nodeId, resultId),
      env.DB.prepare(`
        UPDATE architect_projects
        SET status = CASE
          WHEN EXISTS (
            SELECT 1 FROM project_work_items AS wf
            WHERE wf.project_id = architect_projects.project_id
              AND wf.status = 'failed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_work_items AS wu
            WHERE wu.project_id = architect_projects.project_id
              AND wu.status IN ('planned','assigned','running')
          ) THEN 'blocked'
          WHEN NOT EXISTS (
            SELECT 1 FROM project_work_items AS wu
            WHERE wu.project_id = architect_projects.project_id
              AND wu.status IN ('planned','assigned','running')
          ) THEN 'completed'
          ELSE 'running'
        END,
        updated_at = CURRENT_TIMESTAMP
        WHERE project_id = (
          SELECT project_id FROM project_work_items
          WHERE ('assignment_' || work_item_id) = ?
          LIMIT 1
        )
          AND EXISTS (SELECT 1 FROM results WHERE result_id = ?)
      `).bind(assignmentId, resultId)
    );
  }

  resultStatements.push(
    env.DB.prepare(`
      UPDATE missions
      SET status = 'completed'
      WHERE mission_id = (
        SELECT mission_id FROM assignments WHERE assignment_id = ?
      )
        AND status != 'cancelled'
        AND NOT EXISTS (
          SELECT 1
          FROM assignments
          WHERE assignments.mission_id = missions.mission_id
            AND assignments.status IN ('assigned', 'running')
        )
        AND EXISTS (SELECT 1 FROM results WHERE result_id = ?)
    `).bind(assignmentId, resultId),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      )
      SELECT 'node', ?, 'result.submitted', 'assignment', ?, ?
      WHERE EXISTS (SELECT 1 FROM results WHERE result_id = ?)
    `).bind(nodeId, assignmentId, detailsJson, resultId)
  );

  let statements;
  try {
    statements = await env.DB.batch(resultStatements);
  } catch (error) {
    if (String(error).includes("results.assignment_id")) {
      throw new ApiError(409, "result_already_exists");
    }
    throw error;
  }

  if ((statements[0]?.meta?.changes || 0) !== 1) {
    throw new ApiError(409, "assignment_not_active");
  }

  return json({
    ok: true,
    result: {
      result_id: resultId,
      report_id: reportId,
      assignment_id: assignmentId,
      outcome
    }
  }, 201);
}

async function architectListReports(request, env, url) {
  await authenticateArchitect(request, env);
  await backfillLegacyReports(env);

  const rawLimit = url.searchParams.get("limit") || "50";
  const rawOffset = url.searchParams.get("offset") || "0";
  if (!/^\d{1,3}$/.test(rawLimit) || !/^\d{1,7}$/.test(rawOffset)) {
    throw new ApiError(400, "invalid_pagination");
  }
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  if (limit < 1 || limit > 100 || offset < 0 || offset > 1000000) {
    throw new ApiError(400, "invalid_pagination");
  }

  const nodeId = optionalString(url.searchParams.get("node_id"), "node_id", 128);
  const missionId = optionalString(url.searchParams.get("mission_id"), "mission_id", 128);
  const reportType = optionalString(url.searchParams.get("report_type"), "report_type", 64);
  const predicates = [];
  const bindings = [];
  if (nodeId) {
    predicates.push("ar.node_id = ?");
    bindings.push(nodeId);
  }
  if (missionId) {
    predicates.push("ar.mission_id = ?");
    bindings.push(missionId);
  }
  if (reportType) {
    predicates.push("ar.report_type = ?");
    bindings.push(reportType);
  }
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";

  const query = await env.DB.prepare(`
    SELECT
      ar.report_id,
      ar.result_id,
      ar.assignment_id,
      ar.mission_id,
      ar.node_id,
      r.outcome,
      r.summary,
      r.artifact_key,
      ar.report_type,
      ar.report_sha256,
      ar.report_size_bytes,
      ar.sensitivity,
      ar.created_at
    FROM agent_reports AS ar
    JOIN results AS r ON r.result_id = ar.result_id
    ${where}
    ORDER BY ar.created_at DESC, ar.report_id DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings, limit, offset).all();

  const reports = query.results || [];
  return json({
    ok: true,
    reports,
    next_offset: reports.length === limit ? offset + limit : null
  });
}

async function architectGetReport(request, env, reportId) {
  await authenticateArchitect(request, env);
  await backfillLegacyReports(env);

  const report = await env.DB.prepare(`
    SELECT
      ar.report_id,
      r.result_id,
      ar.assignment_id,
      ar.mission_id,
      ar.node_id,
      r.outcome,
      r.summary,
      r.artifact_key,
      r.metrics_json,
      ar.report_type,
      ar.report_json,
      ar.report_sha256,
      ar.report_size_bytes,
      ar.sensitivity,
      ar.created_at
    FROM agent_reports AS ar
    JOIN results AS r ON r.result_id = ar.result_id
    WHERE ar.report_id = ? OR ar.result_id = ?
  `).bind(reportId, reportId).first();

  if (!report) {
    throw new ApiError(404, "report_not_found");
  }

  return json({
    ok: true,
    report: {
      ...report,
      metrics: safeJson(report.metrics_json, {}),
      content: safeJson(report.report_json, null),
      metrics_json: undefined,
      report_json: undefined
    }
  });
}

function normalizeSessionUiState(value) {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_ui_state");
  }

  const normalized = {};
  for (const [field, maxLength] of Object.entries({
    selected_node_id: 128,
    selected_control_node_id: 128,
    selected_report_id: 128,
    report_type_filter: 64,
    expanded_section: 64
  })) {
    const item = optionalString(value[field], field, maxLength);
    if (item) normalized[field] = item;
  }
  return normalized;
}

async function architectListSessions(request, env, url) {
  await authenticateArchitect(request, env);
  await ensureSessionStorage(env);

  const rawLimit = url.searchParams.get("limit") || "30";
  const rawOffset = url.searchParams.get("offset") || "0";
  if (!/^\d{1,3}$/.test(rawLimit) || !/^\d{1,7}$/.test(rawOffset)) {
    throw new ApiError(400, "invalid_pagination");
  }
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  if (limit < 1 || limit > 100 || offset < 0 || offset > 1000000) {
    throw new ApiError(400, "invalid_pagination");
  }

  const query = await env.DB.prepare(`
    SELECT session_id, name, schema_version, snapshot_sha256,
      snapshot_size_bytes, status, created_at, updated_at
    FROM architect_sessions
    ORDER BY updated_at DESC, session_id DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  const sessions = query.results || [];
  return json({
    ok: true,
    sessions,
    next_offset: sessions.length === limit ? offset + limit : null
  });
}

async function architectCreateSession(request, env) {
  await authenticateArchitect(request, env);
  await Promise.all([ensureReportStorage(env), ensureSessionStorage(env)]);
  const bodyText = await readBodyText(request, MAX_SESSION_BODY_BYTES);
  const body = parseJsonObject(bodyText);
  const name = requireString(body.name, "session_name", 120);
  const uiState = normalizeSessionUiState(body.ui_state);

  const counts = await env.DB.prepare(
    "SELECT " +
    "(SELECT COUNT(*) FROM nodes WHERE status != 'revoked') AS nodes, " +
    "(SELECT COUNT(*) FROM missions AS m WHERE m.status NOT IN ('completed','cancelled') " +
    "AND (m.expires_at IS NULL OR datetime(m.expires_at) > CURRENT_TIMESTAMP) " +
    "AND EXISTS (SELECT 1 FROM assignments AS a WHERE a.mission_id = m.mission_id " +
    "AND a.status IN ('assigned','running'))) AS active_missions, " +
    "(SELECT COUNT(*) FROM results) AS results, " +
    "(SELECT COUNT(*) FROM agent_reports) AS reports"
  ).first();
  const savedAt = new Date().toISOString();
  const snapshot = {
    schema_version: 1,
    saved_at: savedAt,
    ui_state: uiState,
    counts: {
      nodes: counts?.nodes || 0,
      missions: counts?.active_missions || 0,
      active_missions: counts?.active_missions || 0,
      results: counts?.results || 0,
      reports: counts?.reports || 0
    }
  };
  const snapshotJson = JSON.stringify(snapshot);
  const snapshotSizeBytes = new TextEncoder().encode(snapshotJson).byteLength;
  if (snapshotSizeBytes > MAX_SESSION_SNAPSHOT_BYTES) {
    throw new ApiError(413, "session_snapshot_too_large");
  }

  const sessionId = `session_${crypto.randomUUID()}`;
  const snapshotSha256 = await sha256Hex(snapshotJson);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO architect_sessions (
        session_id, name, schema_version, snapshot_json, snapshot_sha256,
        snapshot_size_bytes, status, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, 'active', ?, ?)
    `).bind(
      sessionId,
      name,
      snapshotJson,
      snapshotSha256,
      snapshotSizeBytes,
      savedAt,
      savedAt
    ),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      ) VALUES ('architect', 'test-console', 'session.created', 'session', ?, ?)
    `).bind(sessionId, JSON.stringify({ name, schema_version: 1 }))
  ]);

  return json({
    ok: true,
    session: {
      session_id: sessionId,
      name,
      schema_version: 1,
      snapshot_sha256: snapshotSha256,
      snapshot_size_bytes: snapshotSizeBytes,
      status: "active",
      created_at: savedAt,
      updated_at: savedAt
    }
  }, 201);
}

async function architectGetSession(request, env, sessionId) {
  await authenticateArchitect(request, env);
  await ensureSessionStorage(env);
  const session = await env.DB.prepare(`
    SELECT session_id, name, schema_version, snapshot_json, snapshot_sha256,
      snapshot_size_bytes, status, created_at, updated_at
    FROM architect_sessions
    WHERE session_id = ?
  `).bind(sessionId).first();
  if (!session) {
    throw new ApiError(404, "session_not_found");
  }
  return json({
    ok: true,
    session: {
      ...session,
      snapshot: safeJson(session.snapshot_json, null),
      snapshot_json: undefined
    }
  });
}

async function architectUpdateSession(request, env, sessionId) {
  await authenticateArchitect(request, env);
  await ensureSessionStorage(env);
  const bodyText = await readBodyText(request, 8 * 1024);
  const body = parseJsonObject(bodyText);
  const name = body.name === undefined
    ? null
    : requireString(body.name, "session_name", 120);
  const status = body.status === undefined
    ? null
    : requireString(body.status, "session_status", 16);
  if (status !== null && !["active", "archived"].includes(status)) {
    throw new ApiError(400, "invalid_session_status");
  }
  if (name === null && status === null) {
    throw new ApiError(400, "session_update_required");
  }

  const updatedAt = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE architect_sessions
    SET name = COALESCE(?, name),
        status = COALESCE(?, status),
        updated_at = ?
    WHERE session_id = ?
  `).bind(name, status, updatedAt, sessionId).run();
  if ((result?.meta?.changes || 0) !== 1) {
    throw new ApiError(404, "session_not_found");
  }
  await env.DB.prepare(`
    INSERT INTO audit_events (
      actor_type, actor_id, action, target_type, target_id, details_json
    ) VALUES ('architect', 'test-console', 'session.updated', 'session', ?, ?)
  `).bind(sessionId, JSON.stringify({ name, status })).run();
  return architectGetSession(request, env, sessionId);
}

async function architectDeleteSession(request, env, sessionId) {
  await authenticateArchitect(request, env);
  await ensureSessionStorage(env);
  const existing = await env.DB.prepare(
    "SELECT session_id, name FROM architect_sessions WHERE session_id = ?"
  ).bind(sessionId).first();
  if (!existing) {
    throw new ApiError(404, "session_not_found");
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM architect_sessions WHERE session_id = ?"
    ).bind(sessionId),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      ) VALUES ('architect', 'test-console', 'session.deleted', 'session', ?, ?)
    `).bind(sessionId, JSON.stringify({ name: existing.name }))
  ]);
  return json({ ok: true, deleted_session_id: sessionId });
}

async function architectStorageUsage(request, env) {
  await authenticateArchitect(request, env);
  await Promise.all([backfillLegacyReports(env), ensureSessionStorage(env)]);
  const usage = await env.DB.prepare(
    "SELECT " +
    "(SELECT COUNT(*) FROM agent_reports) AS report_count, " +
    "(SELECT COALESCE(SUM(report_size_bytes), 0) FROM agent_reports) AS report_bytes, " +
    "(SELECT COUNT(*) FROM architect_sessions) AS session_count, " +
    "(SELECT COALESCE(SUM(snapshot_size_bytes), 0) FROM architect_sessions) AS session_bytes"
  ).first();
  return json({
    ok: true,
    usage: {
      report_count: usage?.report_count || 0,
      report_bytes: usage?.report_bytes || 0,
      session_count: usage?.session_count || 0,
      session_bytes: usage?.session_bytes || 0,
      safe_d1_target_bytes: 400 * 1024 * 1024,
      d1_database_limit_bytes: 500 * 1024 * 1024,
      max_report_bytes: MAX_REPORT_BYTES
    }
  });
}

async function expireStaleNodeCommands(env, nodeId) {
  const cutoff = new Date(Date.now() - COMMAND_MAX_AGE_SECONDS * 1000).toISOString();
  const stale = await env.DB.prepare(`
    SELECT command_id, command_type, status, created_at
    FROM commands
    WHERE node_id = ?
      AND status IN ('pending', 'accepted')
      AND datetime(created_at) < datetime(?)
    ORDER BY created_at ASC
    LIMIT 20
  `).bind(nodeId, cutoff).all();

  const rows = stale.results || [];
  for (const row of rows) {
    const update = await env.DB.prepare(`
      UPDATE commands
      SET status = 'failed', completed_at = CURRENT_TIMESTAMP
      WHERE command_id = ?
        AND node_id = ?
        AND status IN ('pending', 'accepted')
        AND datetime(created_at) < datetime(?)
    `).bind(row.command_id, nodeId, cutoff).run();
    if ((update?.meta?.changes || 0) === 1) {
      await env.DB.prepare(`
        INSERT INTO audit_events (
          actor_type, actor_id, action, target_type, target_id, details_json
        ) VALUES ('controller', 'controller', 'command.expired', 'command', ?, ?)
      `).bind(
        row.command_id,
        JSON.stringify({
          node_id: nodeId,
          command_type: row.command_type,
          previous_status: row.status,
          created_at: row.created_at,
          max_age_seconds: COMMAND_MAX_AGE_SECONDS
        })
      ).run();
    }
  }
  return rows.length;
}

async function listCommands(request, env, nodeId, url) {
  const node = await authenticateNode(request, env, nodeId, url, new Uint8Array(0));
  await expireStaleNodeCommands(env, nodeId);
  await ensureRolloutCommandForNode(env, nodeId);

  const query = await env.DB.prepare(`
    SELECT command_id, command_type, payload_json, signature, status, created_at
    FROM commands
    WHERE node_id = ? AND status IN ('pending', 'accepted')
    ORDER BY created_at ASC
    LIMIT 20
  `).bind(nodeId).all();

  const commands = (query.results || []).map((row) => ({
    ...row,
    payload: safeJson(row.payload_json, {}),
    payload_json: undefined
  }));
  return json({ ok: true, node_status: node.status, commands });
}

async function acknowledgeCommand(request, env, nodeId, commandId, url) {
  const { bytes: bodyBytes, text: bodyText } = await readBody(request, 8 * 1024);
  const node = await authenticateNode(request, env, nodeId, url, bodyBytes);
  const body = parseJsonObject(bodyText);
  const status = requireString(body.status, "status", 16);
  if (!ALLOWED_COMMAND_ACKS.has(status)) {
    throw new ApiError(400, "invalid_command_status");
  }

  const current = await env.DB.prepare(`
    SELECT command_id, command_type, payload_json, status
    FROM commands
    WHERE command_id = ? AND node_id = ?
  `).bind(commandId, nodeId).first();
  if (!current) {
    throw new ApiError(404, "command_not_found");
  }

  const transitionAllowed =
    (current.status === "pending" && ["accepted", "completed", "failed"].includes(status)) ||
    (current.status === "accepted" && ["completed", "failed"].includes(status));
  if (!transitionAllowed) {
    throw new ApiError(409, "invalid_command_transition");
  }

  const detailsJson = JSON.stringify({ status });
  const statements = [
    env.DB.prepare(`
      UPDATE commands
      SET status = ?,
          completed_at = CASE
            WHEN ? IN ('completed', 'failed') THEN CURRENT_TIMESTAMP
            ELSE completed_at
          END
      WHERE command_id = ?
        AND node_id = ?
        AND status = ?
    `).bind(status, status, commandId, nodeId, current.status),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      )
      SELECT 'node', ?, 'command.acknowledged', 'command', ?, ?
      WHERE changes() = 1
    `).bind(nodeId, commandId, detailsJson)
  ];

  const nodeStatus = status === "completed"
    ? { pause: "paused", resume: "online", stop: "offline", uninstall: "revoked" }[current.command_type]
    : null;
  if (nodeStatus) {
    statements.push(env.DB.prepare(`
      UPDATE nodes
      SET status = ?, last_seen_at = CURRENT_TIMESTAMP
      WHERE node_id = ?
    `).bind(nodeStatus, nodeId));
  }

  if (status === "completed" && current.command_type.startsWith("lmstudio_")) {
    await ensureNodeAiStorage(env);
    const payload = safeJson(current.payload_json, {});
    const model = typeof payload.model === "string" ? payload.model : null;
    if (current.command_type === "lmstudio_install") {
      statements.push(env.DB.prepare(`
        INSERT INTO node_ai_state (node_id, installed, server_running, last_action, updated_at)
        VALUES (?, 1, 1, 'installed', CURRENT_TIMESTAMP)
        ON CONFLICT(node_id) DO UPDATE SET
          installed = 1, server_running = 1, last_action = 'installed', updated_at = CURRENT_TIMESTAMP
      `).bind(nodeId));
    } else if (current.command_type === "lmstudio_model_get") {
      statements.push(env.DB.prepare(`
        INSERT INTO node_ai_state (node_id, installed, selected_model, last_action, updated_at)
        VALUES (?, 1, ?, 'model_downloaded', CURRENT_TIMESTAMP)
        ON CONFLICT(node_id) DO UPDATE SET
          installed = 1, selected_model = excluded.selected_model,
          last_action = 'model_downloaded', updated_at = CURRENT_TIMESTAMP
      `).bind(nodeId, model));
    } else if (current.command_type === "lmstudio_model_load") {
      statements.push(env.DB.prepare(`
        INSERT INTO node_ai_state (
          node_id, installed, selected_model, loaded_model, server_running, last_action, updated_at
        ) VALUES (?, 1, ?, ?, 1, 'model_loaded', CURRENT_TIMESTAMP)
        ON CONFLICT(node_id) DO UPDATE SET
          installed = 1, selected_model = excluded.selected_model,
          loaded_model = excluded.loaded_model, server_running = 1,
          last_action = 'model_loaded', updated_at = CURRENT_TIMESTAMP
      `).bind(nodeId, model, model));
    }
  }

  const results = await env.DB.batch(statements);
  if ((results[0]?.meta?.changes || 0) !== 1) {
    throw new ApiError(409, "invalid_command_transition");
  }

  let projectAssignmentsCreated = 0;
  if (status === "completed" && current.command_type === "lmstudio_model_load") {
    projectAssignmentsCreated = await materializeProjectWorkForNode(env, nodeId);
  }

  const command = await env.DB.prepare(`
    SELECT command_id, command_type, status, completed_at
    FROM commands
    WHERE command_id = ? AND node_id = ?
  `).bind(commandId, nodeId).first();

  return json({
    ok: true,
    command,
    node_status: nodeStatus || node.status,
    project_assignments_created: projectAssignmentsCreated
  });
}

function constantTimeHexEqual(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    left.length !== 64 ||
    right.length !== 64
  ) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function ensureEnterpriseStorage(env) {
  if (!enterpriseSchemaPromise) {
    enterpriseSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS architect_access_tokens (
          token_id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK (role IN ('viewer','operator')),
          label TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at TEXT,
          revoked_at TEXT
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_architect_access_tokens_enabled
        ON architect_access_tokens(enabled, role, created_at DESC)
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS enterprise_sites (
          site_id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS enterprise_node_groups (
          group_id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS enterprise_node_scope (
          node_id TEXT PRIMARY KEY,
          site_id TEXT,
          group_id TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
          FOREIGN KEY (site_id) REFERENCES enterprise_sites(site_id) ON DELETE SET NULL,
          FOREIGN KEY (group_id) REFERENCES enterprise_node_groups(group_id) ON DELETE SET NULL
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_enterprise_node_scope_site
        ON enterprise_node_scope(site_id, node_id)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_enterprise_node_scope_group
        ON enterprise_node_scope(group_id, node_id)
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS enterprise_desired_state (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          policy_json TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
    ]).catch((error) => {
      enterpriseSchemaPromise = undefined;
      throw error;
    });
  }
  await enterpriseSchemaPromise;
  await env.DB.prepare(`
    INSERT OR IGNORE INTO enterprise_desired_state (singleton_id, policy_json)
    VALUES (1, ?)
  `).bind(JSON.stringify(DEFAULT_ENTERPRISE_POLICY)).run();
}

function bootstrapArchitectHash(env) {
  const hash = typeof env.ARCHITECT_TOKEN_HASH === "string"
    ? env.ARCHITECT_TOKEN_HASH.trim().toLowerCase()
    : "";
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new ApiError(503, "architect_auth_not_configured");
  }
  return hash;
}

async function ensureArchitectAuthStorage(env) {
  const bootstrapHash = bootstrapArchitectHash(env);
  if (!architectAuthSchemaPromise) {
    architectAuthSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS architect_auth_state (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          token_hash TEXT NOT NULL,
          bootstrap_mode INTEGER NOT NULL DEFAULT 1 CHECK (bootstrap_mode IN (0,1)),
          recovery_hash TEXT,
          recovery_used INTEGER NOT NULL DEFAULT 1 CHECK (recovery_used IN (0,1)),
          token_rotated_at TEXT,
          recovery_created_at TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS architect_recovery_attempts (
          actor_hash TEXT NOT NULL,
          window_key TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (actor_hash, window_key)
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_architect_recovery_attempts_updated
        ON architect_recovery_attempts(updated_at)
      `)
    ]).catch((error) => {
      architectAuthSchemaPromise = undefined;
      throw error;
    });
  }
  await architectAuthSchemaPromise;
  await env.DB.prepare(`
    INSERT OR IGNORE INTO architect_auth_state (
      singleton_id, token_hash, bootstrap_mode, recovery_used
    ) VALUES (1, ?, 1, 1)
  `).bind(bootstrapHash).run();
}

function randomArchitectSecret(prefix) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return prefix + bytesToBase64Url(bytes);
}

async function architectAuthState(env) {
  await ensureArchitectAuthStorage(env);
  const row = await env.DB.prepare(`
    SELECT token_hash, bootstrap_mode, recovery_hash, recovery_used,
      token_rotated_at, recovery_created_at, updated_at
    FROM architect_auth_state WHERE singleton_id = 1
  `).first();
  if (!row || !/^[a-f0-9]{64}$/.test(String(row.token_hash || ""))) {
    throw new ApiError(503, "architect_auth_not_configured");
  }
  return row;
}

async function authenticateArchitect(request, env) {
  const state = await architectAuthState(env);
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || "";
  if (!token || token.length > 512) {
    throw new ApiError(401, "architect_authentication_required");
  }

  const actualHash = await sha256Hex(token);
  if (!constantTimeHexEqual(actualHash, String(state.token_hash).toLowerCase())) {
    throw new ApiError(401, "invalid_architect_token");
  }
}

function recoveryWindowKey(now = new Date()) {
  const value = new Date(now);
  value.setUTCMinutes(Math.floor(value.getUTCMinutes() / 15) * 15, 0, 0);
  return value.toISOString();
}

async function consumeRecoveryAttempt(request, env) {
  await ensureArchitectAuthStorage(env);
  const rawActor = (request.headers.get("cf-connecting-ip") || "unknown").trim();
  const actorHash = await sha256Hex(rawActor);
  const windowKey = recoveryWindowKey();
  const pruneBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "DELETE FROM architect_recovery_attempts WHERE updated_at < ?"
  ).bind(pruneBefore).run();
  const row = await env.DB.prepare(`
    INSERT INTO architect_recovery_attempts (actor_hash, window_key, attempts, updated_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(actor_hash, window_key) DO UPDATE SET
      attempts = architect_recovery_attempts.attempts + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE architect_recovery_attempts.attempts < 5
    RETURNING attempts
  `).bind(actorHash, windowKey).first();
  if (!row) throw new ApiError(429, "architect_recovery_rate_limited");
}

async function architectSecurityStatus(request, env) {
  await authenticateArchitect(request, env);
  const state = await architectAuthState(env);
  return json({
    ok: true,
    security: {
      recovery_configured: Boolean(state.recovery_hash) && Number(state.recovery_used || 0) === 0,
      bootstrap_mode: Number(state.bootstrap_mode || 0) === 1,
      token_rotated_at: state.token_rotated_at || null,
      recovery_created_at: state.recovery_created_at || null
    }
  });
}

async function architectCreateRecoveryCode(request, env) {
  await authenticateArchitect(request, env);
  const body = parseJsonObject(await readBodyText(request, 4096));
  if (body.confirm !== "CREATE_RECOVERY_CODE") {
    throw new ApiError(400, "recovery_confirmation_required");
  }
  const recoveryCode = randomArchitectSecret("citadel_recovery_");
  const recoveryHash = await sha256Hex(recoveryCode);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE architect_auth_state
      SET recovery_hash = ?, recovery_used = 0,
          recovery_created_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `).bind(recoveryHash),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      ) VALUES ('architect', 'security', 'architect.recovery_code.rotated',
        'architect_auth', 'singleton', '{}')
    `)
  ]);
  return json({
    ok: true,
    recovery_code: recoveryCode,
    display_once: true
  }, 201);
}

async function architectRotateToken(request, env) {
  await authenticateArchitect(request, env);
  const body = parseJsonObject(await readBodyText(request, 4096));
  if (body.confirm !== "ROTATE_ARCHITECT_TOKEN") {
    throw new ApiError(400, "token_rotation_confirmation_required");
  }
  const token = randomArchitectSecret("citadel_arch_");
  const tokenHash = await sha256Hex(token);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE architect_auth_state
      SET token_hash = ?, bootstrap_mode = 0,
          token_rotated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `).bind(tokenHash),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      ) VALUES ('architect', 'security', 'architect.token.rotated',
        'architect_auth', 'singleton', '{"method":"authenticated"}')
    `)
  ]);
  return json({
    ok: true,
    architect_token: token,
    display_once: true,
    old_token_invalidated: true
  });
}

async function architectSyncBootstrapReset(request, env) {
  const expectedHash = bootstrapArchitectHash(env);
  const suppliedHash = (request.headers.get("x-citadel-bootstrap-hash") || "")
    .trim()
    .toLowerCase();
  if (!constantTimeHexEqual(suppliedHash, expectedHash)) {
    throw new ApiError(401, "invalid_bootstrap_reset_secret");
  }

  const body = parseJsonObject(await readBodyText(request, 4096));
  if (body.confirm !== "RESET_ARCHITECT_ACCESS") {
    throw new ApiError(400, "bootstrap_reset_confirmation_required");
  }

  await ensureArchitectAuthStorage(env);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE architect_auth_state
      SET token_hash = ?, bootstrap_mode = 0,
          recovery_hash = NULL, recovery_used = 1,
          token_rotated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `).bind(expectedHash),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      ) VALUES ('github_actions', 'protected_environment',
        'architect.token.bootstrap_reset',
        'architect_auth', 'singleton',
        '{"method":"worker_binding","recovery_code_invalidated":true}')
    `)
  ]);

  return json({
    ok: true,
    architect_verifier_synced: true,
    old_token_invalidated: true,
    recovery_code_invalidated: true
  });
}

async function architectRecoverToken(request, env) {
  await consumeRecoveryAttempt(request, env);
  const body = parseJsonObject(await readBodyText(request, 4096));
  if (body.confirm !== "RECOVER_ARCHITECT_TOKEN") {
    throw new ApiError(400, "recovery_confirmation_required");
  }
  const recoveryCode = requireString(body.recovery_code, "recovery_code", 512);
  const state = await architectAuthState(env);
  const expectedHash = typeof state.recovery_hash === "string"
    ? state.recovery_hash.toLowerCase()
    : "";
  const actualHash = await sha256Hex(recoveryCode);
  if (
    Number(state.recovery_used || 1) !== 0 ||
    !/^[a-f0-9]{64}$/.test(expectedHash) ||
    !constantTimeHexEqual(actualHash, expectedHash)
  ) {
    throw new ApiError(401, "invalid_recovery_code");
  }

  const token = randomArchitectSecret("citadel_arch_");
  const tokenHash = await sha256Hex(token);
  const result = await env.DB.prepare(`
    UPDATE architect_auth_state
    SET token_hash = ?, bootstrap_mode = 0,
        recovery_hash = NULL, recovery_used = 1,
        token_rotated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1 AND recovery_used = 0 AND recovery_hash = ?
  `).bind(tokenHash, expectedHash).run();
  if ((result.meta?.changes || 0) !== 1) {
    throw new ApiError(409, "recovery_code_already_used");
  }
  await env.DB.prepare(`
    INSERT INTO audit_events (
      actor_type, actor_id, action, target_type, target_id, details_json
    ) VALUES ('architect_recovery', 'recovery', 'architect.token.recovered',
      'architect_auth', 'singleton', '{"recovery_code_consumed":true}')
  `).run();

  return json({
    ok: true,
    architect_token: token,
    display_once: true,
    old_token_invalidated: true,
    recovery_code_consumed: true
  });
}

async function architectExperience(request, env) {
  await authenticateArchitect(request, env);
  return json({ ok: true, ...getProjectExperienceRegistry() });
}

async function architectOverview(request, env) {
  await authenticateArchitect(request, env);
  await Promise.all([
    backfillLegacyReports(env),
    ensureSessionStorage(env),
    ensureAutoEnrollmentStorage(env),
    ensureProjectStorage(env),
    ensureNodeNetworkStorage(env),
    ensureNodeAiStorage(env)
  ]);

  const [counts, nodesQuery, missionsQuery, commandsQuery] = await Promise.all([
    env.DB.prepare(
      "SELECT " +
      "(SELECT COUNT(*) FROM nodes WHERE status != 'revoked') AS nodes, " +
      "(SELECT COUNT(*) FROM nodes WHERE status = 'online' " +
      "AND datetime(last_seen_at) >= datetime('now', '-5 minutes')) AS online_nodes, " +
      "(SELECT COUNT(*) FROM missions AS m WHERE m.status NOT IN ('completed','cancelled') " +
      "AND (m.expires_at IS NULL OR datetime(m.expires_at) > CURRENT_TIMESTAMP) " +
      "AND EXISTS (SELECT 1 FROM assignments AS a WHERE a.mission_id = m.mission_id " +
      "AND a.status IN ('assigned','running'))) AS active_missions, " +
      "(SELECT COUNT(*) FROM agent_reports) AS reports, " +
      "(SELECT COUNT(*) FROM architect_sessions) AS sessions"
    ).first(),
    env.DB.prepare(
      "SELECT n.node_id, nn.node_number, n.hostname, n.os_name, n.os_version, n.architecture, " +
      "n.agent_version, CASE WHEN n.status = 'online' " +
      "AND (n.last_seen_at IS NULL OR datetime(n.last_seen_at) < datetime('now', '-5 minutes')) " +
      "THEN 'offline' ELSE n.status END AS status, n.cpu_percent, n.memory_percent, " +
      "n.enrolled_at, n.last_seen_at, net.lan_ipv4, net.tailscale_ipv4, net.mac_addresses_json, " +
      "ai.installed AS lmstudio_installed, ai.selected_model AS lmstudio_selected_model, " +
      "ai.loaded_model AS lmstudio_loaded_model, ai.server_running AS lmstudio_server_running, " +
      "ai.last_action AS lmstudio_last_action, ai.updated_at AS lmstudio_updated_at, " +
      "air.state_json AS lmstudio_runtime_json, " +
      "(SELECT nl.event_type FROM node_logs AS nl WHERE nl.node_id = n.node_id " +
      "ORDER BY datetime(nl.created_at) DESC, nl.event_id DESC LIMIT 1) AS last_event_type, " +
      "(SELECT nl.message FROM node_logs AS nl WHERE nl.node_id = n.node_id " +
      "ORDER BY datetime(nl.created_at) DESC, nl.event_id DESC LIMIT 1) AS last_event_message, " +
      "(SELECT nl.created_at FROM node_logs AS nl WHERE nl.node_id = n.node_id " +
      "ORDER BY datetime(nl.created_at) DESC, nl.event_id DESC LIMIT 1) AS last_event_at, " +
      "(SELECT c.command_type FROM commands AS c WHERE c.node_id = n.node_id " +
      "ORDER BY datetime(c.created_at) DESC, c.command_id DESC LIMIT 1) AS last_command_type, " +
      "(SELECT c.status FROM commands AS c WHERE c.node_id = n.node_id " +
      "ORDER BY datetime(c.created_at) DESC, c.command_id DESC LIMIT 1) AS last_command_status, " +
      "(SELECT c.completed_at FROM commands AS c WHERE c.node_id = n.node_id " +
      "ORDER BY datetime(c.created_at) DESC, c.command_id DESC LIMIT 1) AS last_command_at, " +
      "(SELECT pwi.role_name FROM project_work_items AS pwi " +
      "JOIN architect_projects AS ap ON ap.project_id = pwi.project_id " +
      "WHERE pwi.node_id = n.node_id " +
      "AND pwi.status IN ('planned','assigned','running') " +
      "AND ap.status IN ('planned','running') " +
      "ORDER BY pwi.created_at DESC, pwi.sequence_no DESC LIMIT 1) AS planned_role " +
      "FROM nodes AS n " +
      "LEFT JOIN node_numbers AS nn ON nn.node_id = n.node_id " +
      "LEFT JOIN node_network_state AS net ON net.node_id = n.node_id " +
      "LEFT JOIN node_ai_state AS ai ON ai.node_id = n.node_id " +
      "LEFT JOIN node_ai_runtime_state AS air ON air.node_id = n.node_id " +
      "WHERE n.status != 'revoked' " +
      "ORDER BY n.last_seen_at DESC LIMIT 100"
    ).all(),
    env.DB.prepare(
      "SELECT m.mission_id, m.title, m.mission_type, m.payload_json, " +
      "CASE WHEN m.expires_at IS NOT NULL AND datetime(m.expires_at) <= CURRENT_TIMESTAMP " +
      "AND m.status NOT IN ('completed', 'cancelled') THEN 'expired' ELSE m.status END AS status, " +
      "m.priority, m.created_at, m.expires_at, a.assignment_id, " +
      "a.node_id, a.status AS assignment_status, r.result_id, " +
      "r.outcome, r.summary, r.metrics_json, " +
      "r.created_at AS result_created_at FROM missions AS m " +
      "LEFT JOIN assignments AS a ON a.assignment_id = (" +
      "SELECT a2.assignment_id FROM assignments AS a2 " +
      "WHERE a2.mission_id = m.mission_id " +
      "ORDER BY a2.assigned_at DESC, a2.assignment_id DESC LIMIT 1" +
      ") LEFT JOIN results AS r ON r.assignment_id = a.assignment_id " +
      "ORDER BY m.created_at DESC LIMIT 100"
    ).all(),
    env.DB.prepare(
      "SELECT command_id, node_id, command_type, status, created_at, completed_at " +
      "FROM commands WHERE status IN ('pending', 'accepted') " +
      "OR command_id IN (" +
      "SELECT command_id FROM commands WHERE status NOT IN ('pending', 'accepted') " +
      "ORDER BY created_at DESC LIMIT 50" +
      ") ORDER BY created_at DESC"
    ).all()
  ]);

  const missions = (missionsQuery.results || []).map((row) => {
    const payload = safeJson(row.payload_json, {});
    return {
      ...row,
      task_text: typeof payload.task_text === "string" ? payload.task_text : null,
      payload_json: undefined,
      metrics: safeJson(row.metrics_json, {}),
      metrics_json: undefined
    };
  });

  const rawNodes = nodesQuery.results || [];
  const liveRelays = rawNodes.filter((node) =>
    node.status === "online" &&
    node.lan_ipv4 &&
    Date.parse(String(node.last_seen_at).replace(" ", "T") + (String(node.last_seen_at).includes("T") ? "" : "Z")) >= Date.now() - 5 * 60 * 1000
  );
  const nodes = rawNodes.map((node) => {
    const macAddresses = safeJson(node.mac_addresses_json, []);
    const prefix = subnet24(node.lan_ipv4);
    const relay = prefix && Array.isArray(macAddresses) && macAddresses.length
      ? liveRelays.find((candidate) =>
          candidate.node_id !== node.node_id && subnet24(candidate.lan_ipv4) === prefix
        )
      : null;
    return {
      ...node,
      lmstudio_runtime: safeJson(node.lmstudio_runtime_json, {}),
      lmstudio_runtime_json: undefined,
      mac_addresses: Array.isArray(macAddresses) ? macAddresses : [],
      mac_addresses_json: undefined,
      wake_available: node.status === "offline" && Boolean(relay),
      wake_relay_node_id: relay?.node_id || null
    };
  });

  return json({
    ok: true,
    counts: {
      nodes: counts?.nodes || 0,
      online_nodes: counts?.online_nodes || 0,
      missions: counts?.active_missions || 0,
      active_missions: counts?.active_missions || 0,
      reports: counts?.reports || 0,
      sessions: counts?.sessions || 0
    },
    nodes,
    missions,
    commands: commandsQuery.results || []
  });
}

async function publicHubNodes(env) {
  await ensureAutoEnrollmentStorage(env);
  const query = await env.DB.prepare(
    "SELECT nn.node_number, n.agent_version, n.status, n.enrolled_at, n.last_seen_at " +
    "FROM node_numbers AS nn JOIN nodes AS n ON n.node_id = nn.node_id " +
    "WHERE n.status != 'revoked' ORDER BY nn.node_number ASC LIMIT 500"
  ).all();
  return json({
    ok: true,
    refreshed_at: new Date().toISOString(),
    nodes: (query.results || []).map((node) => ({
      node_number: node.node_number,
      display_name: `CITADEL Node ${node.node_number}`,
      agent_version: node.agent_version,
      status: node.status,
      enrolled_at: node.enrolled_at,
      last_seen_at: node.last_seen_at
    }))
  });
}

async function architectRelease(request, env) {
  await authenticateArchitect(request, env);
  return json({ ok: true, release: LATEST_NODE_RELEASE, lmstudio: LMSTUDIO_INTEGRATION });
}

async function architectCreateCommand(request, env, nodeId) {
  await authenticateArchitect(request, env);
  await ensureCommandStorage(env);
  const bodyText = await readBodyText(request, 8 * 1024);
  const body = parseJsonObject(bodyText);
  const commandType = requireString(body.command_type, "command_type", 32);
  if (!ALLOWED_ARCHITECT_COMMAND_TYPES.has(commandType)) {
    throw new ApiError(400, "command_type_not_allowed");
  }
  const requiredPowerConfirmation = POWER_COMMAND_CONFIRMATIONS[commandType];
  if (requiredPowerConfirmation) {
    const confirmation = typeof body.confirmation === "string" ? body.confirmation.trim() : "";
    if (confirmation !== requiredPowerConfirmation) {
      throw new ApiError(400, "power_confirmation_required");
    }
  }

  const node = await env.DB.prepare(
    "SELECT node_id, status, agent_version, os_name, architecture, last_seen_at, " +
    "CASE WHEN last_seen_at IS NOT NULL " +
    "AND datetime(last_seen_at) >= datetime('now', '-5 minutes') THEN 1 ELSE 0 END AS recently_seen " +
    "FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();
  if (!node) {
    throw new ApiError(404, "node_not_found");
  }
  if (node.status === "revoked") {
    throw new ApiError(409, "node_revoked");
  }
  if (Number(node.recently_seen || 0) !== 1) {
    throw new ApiError(409, "node_offline");
  }
  if (commandType === "stop" && node.agent_version !== LATEST_NODE_RELEASE.version) {
    throw new ApiError(409, "agent_update_required");
  }
  if ((commandType.startsWith("lmstudio_") || commandType === "hybrid_query") && node.agent_version !== LATEST_NODE_RELEASE.version) {
    throw new ApiError(409, "agent_update_required");
  }
  if (commandType === "pause" && node.status === "paused") {
    throw new ApiError(409, "node_already_paused");
  }
  if (commandType === "resume" && node.status !== "paused") {
    throw new ApiError(409, "node_not_paused");
  }

  const pending = await env.DB.prepare(
    "SELECT command_id FROM commands " +
    "WHERE node_id = ? AND status IN ('pending', 'accepted') LIMIT 1"
  ).bind(nodeId).first();
  if (pending) {
    throw new ApiError(409, "command_already_pending");
  }

  const commandId = "command_" + crypto.randomUUID();
  let payload = {};
  if (commandType === "update") {
    payload = LATEST_NODE_RELEASE;
  } else if (commandType === "lmstudio_install") {
    payload = { asset: lmstudioInstallAssetForNode(node) };
  } else if (commandType === "lmstudio_probe") {
    payload = {};
  } else if (commandType === "lmstudio_model_get" || commandType === "lmstudio_model_load") {
    await ensureNodeAiStorage(env);
    const aiState = await env.DB.prepare(
      "SELECT installed FROM node_ai_state WHERE node_id = ?"
    ).bind(nodeId).first();
    if (Number(aiState?.installed || 0) !== 1) {
      throw new ApiError(409, "lmstudio_not_installed");
    }
    const source = body.source === undefined ? "catalog" : requireString(body.source, "lmstudio_source", 24);
    if (!["catalog", "huggingface"].includes(source)) throw new ApiError(400, "invalid_lmstudio_source");
    payload = {
      model: normalizeLmModelId(body.model),
      source,
      quantization: normalizeLmQuantization(body.quantization),
      settings: normalizeLmLoadSettings(body.settings)
    };
  } else if (commandType === "hybrid_query") {
    await ensureNodeAiStorage(env);
    const ai = await nodeAiStateResponse(env, nodeId);
    if (body.mode !== "python" && (Number(ai.installed || 0) !== 1 || Number(ai.server_running || 0) !== 1 || !ai.loaded_model)) {
      throw new ApiError(409, "lmstudio_model_not_ready");
    }
    const mode = requireString(body.mode, "hybrid_mode", 16);
    if (!["python","lmstudio","both"].includes(mode)) throw new ApiError(400, "invalid_hybrid_mode");
    const prompt = requireString(body.prompt, "hybrid_prompt", 8000);
    payload = {
      request_id: "query_" + crypto.randomUUID().replaceAll("-", ""),
      mode,
      prompt,
      settings: normalizeHybridSettings(body.settings)
    };
  }
  const payloadJson = JSON.stringify(payload);
  const createdAt = new Date().toISOString();
  const signature = await signControllerCommand(
    env,
    commandId,
    nodeId,
    commandType,
    payloadJson,
    createdAt
  );
  const detailsJson = JSON.stringify({ node_id: nodeId, command_type: commandType });

  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO commands (" +
        "command_id, node_id, command_type, payload_json, signature, status, created_at" +
        ") VALUES (?, ?, ?, ?, ?, 'pending', ?)"
      ).bind(commandId, nodeId, commandType, payloadJson, signature, createdAt),
      env.DB.prepare(
        "INSERT INTO audit_events (" +
        "actor_type, actor_id, action, target_type, target_id, details_json" +
        ") SELECT 'architect', 'test-console', 'command.created', 'command', ?, ? " +
        "WHERE EXISTS (SELECT 1 FROM commands WHERE command_id = ?)"
      ).bind(commandId, detailsJson, commandId)
    ]);
  } catch (error) {
    if (String(error).includes("idx_commands_one_active_per_node") || String(error).includes("UNIQUE")) {
      throw new ApiError(409, "command_already_pending");
    }
    throw error;
  }

  return json({
    ok: true,
    command: {
      command_id: commandId,
      node_id: nodeId,
      command_type: commandType,
      status: "pending",
      created_at: createdAt
    }
  }, 201);
}

async function nodeUpdateAiState(request, env, nodeId, url) {
  const { bytes: bodyBytes, text: bodyText } = await readBody(request, 128 * 1024);
  await authenticateNode(request, env, nodeId, url, bodyBytes);
  const state = normalizeAiState(parseJsonObject(bodyText));
  await upsertNodeAiState(env, nodeId, state);
  return json({ ok: true, node_id: nodeId, ai: await nodeAiStateResponse(env, nodeId) });
}

async function architectNodeAiState(request, env, nodeId) {
  await authenticateArchitect(request, env);
  const node = await env.DB.prepare(
    "SELECT node_id, status, agent_version, last_seen_at FROM nodes WHERE node_id = ? AND status != 'revoked'"
  ).bind(nodeId).first();
  if (!node) throw new ApiError(404, "node_not_found");
  return json({ ok: true, node, ai: await nodeAiStateResponse(env, nodeId) });
}

async function architectSearchModels(request, env, url) {
  await authenticateArchitect(request, env);
  const query = requireString(url.searchParams.get("q"), "model_search", 80);
  const hfUrl = new URL("https://huggingface.co/api/models");
  hfUrl.searchParams.set("search", query);
  hfUrl.searchParams.set("sort", "downloads");
  hfUrl.searchParams.set("direction", "-1");
  hfUrl.searchParams.set("limit", "30");
  hfUrl.searchParams.set("full", "true");
  let response;
  try {
    response = await fetch(hfUrl.toString(), {
      headers: { "accept": "application/json", "user-agent": "CITADEL-EWS/1.0" }
    });
  } catch {
    throw new ApiError(502, "huggingface_unavailable");
  }
  if (!response.ok) {
    throw new ApiError(response.status === 429 ? 429 : 502, "huggingface_search_failed");
  }
  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new ApiError(502, "huggingface_invalid_response");
  }
  if (!Array.isArray(rows)) throw new ApiError(502, "huggingface_invalid_response");
  const models = rows
    .filter((item) => item && typeof item.id === "string")
    .map((item) => ({
      id: item.id,
      downloads: Number(item.downloads || 0),
      likes: Number(item.likes || 0),
      pipeline_tag: typeof item.pipeline_tag === "string" ? item.pipeline_tag : null,
      gguf: Array.isArray(item.tags) && item.tags.some((tag) => String(tag).toLowerCase() === "gguf"),
      last_modified: item.lastModified || item.last_modified || null
    }))
    .sort((a,b) => Number(b.gguf) - Number(a.gguf) || b.downloads - a.downloads)
    .slice(0, 16);
  return json({ ok: true, query, models });
}

async function architectWakeNode(request, env, targetNodeId) {
  await authenticateArchitect(request, env);
  await Promise.all([ensureNodeNetworkStorage(env), ensureCommandStorage(env)]);

  const target = await env.DB.prepare(`
    SELECT n.node_id, n.status, n.last_seen_at, net.lan_ipv4, net.mac_addresses_json
    FROM nodes AS n
    LEFT JOIN node_network_state AS net ON net.node_id = n.node_id
    WHERE n.node_id = ?
  `).bind(targetNodeId).first();
  if (!target) throw new ApiError(404, "node_not_found");
  if (target.status === "revoked") throw new ApiError(409, "node_revoked");
  const targetLive = target.status === "online" && target.last_seen_at &&
    Date.parse(String(target.last_seen_at).replace(" ", "T") + (String(target.last_seen_at).includes("T") ? "" : "Z")) >= Date.now() - 5 * 60 * 1000;
  if (targetLive) throw new ApiError(409, "node_already_online");

  const macAddresses = safeJson(target.mac_addresses_json, []);
  const targetMac = Array.isArray(macAddresses) ? macAddresses.map(normalizeMac).find(Boolean) : null;
  const prefix = subnet24(target.lan_ipv4);
  if (!targetMac || !prefix || !target.lan_ipv4) {
    throw new ApiError(409, "wake_network_identity_unavailable");
  }

  const relaysQuery = await env.DB.prepare(`
    SELECT n.node_id, n.last_seen_at, net.lan_ipv4
    FROM nodes AS n
    JOIN node_network_state AS net ON net.node_id = n.node_id
    WHERE n.node_id != ?
      AND n.status = 'online'
      AND datetime(n.last_seen_at) >= datetime('now', '-5 minutes')
    ORDER BY n.last_seen_at DESC
    LIMIT 100
  `).bind(targetNodeId).all();
  const relay = (relaysQuery.results || []).find((candidate) => subnet24(candidate.lan_ipv4) === prefix);
  if (!relay) throw new ApiError(409, "wake_relay_unavailable");

  const pending = await env.DB.prepare(
    "SELECT command_id FROM commands WHERE node_id = ? AND status IN ('pending','accepted') LIMIT 1"
  ).bind(relay.node_id).first();
  if (pending) throw new ApiError(409, "wake_relay_busy");

  const commandId = "command_" + crypto.randomUUID();
  const payload = {
    target_node_id: targetNodeId,
    target_mac: targetMac,
    target_lan_ipv4: target.lan_ipv4
  };
  const payloadJson = JSON.stringify(payload);
  const createdAt = new Date().toISOString();
  const signature = await signControllerCommand(
    env, commandId, relay.node_id, "wake_peer", payloadJson, createdAt
  );
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO commands (
        command_id, node_id, command_type, payload_json, signature, status, created_at
      ) VALUES (?, ?, 'wake_peer', ?, ?, 'pending', ?)
    `).bind(commandId, relay.node_id, payloadJson, signature, createdAt),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      ) VALUES ('architect', 'test-console', 'node.wake.requested', 'node', ?, ?)
    `).bind(targetNodeId, JSON.stringify({
      relay_node_id: relay.node_id,
      target_lan_ipv4: target.lan_ipv4
    }))
  ]);

  return json({
    ok: true,
    wake: {
      target_node_id: targetNodeId,
      relay_node_id: relay.node_id,
      command_id: commandId,
      status: "pending"
    }
  }, 202);
}

async function architectCreateMission(request, env) {
  await authenticateArchitect(request, env);
  const bodyText = await readBodyText(request, 8 * 1024);
  const body = parseJsonObject(bodyText);

  const nodeId = requireString(body.node_id, "node_id", 128);
  const title = requireString(body.title, "title", 160);
  const taskText = optionalString(body.task_text, "task_text", 2000) ||
    "Проверить состояние выбранного компьютера.";
  const missionType = body.mission_type === undefined
    ? "system_inventory"
    : requireString(body.mission_type, "mission_type", 64);
  if (!ALLOWED_ARCHITECT_MISSION_TYPES.has(missionType)) {
    throw new ApiError(400, "mission_type_not_allowed");
  }

  const priority = body.priority === undefined ? 100 : body.priority;
  if (!Number.isInteger(priority) || priority < 1 || priority > 1000) {
    throw new ApiError(400, "invalid_priority");
  }

  const expiresInHours = body.expires_in_hours === undefined
    ? 24
    : body.expires_in_hours;
  if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
    throw new ApiError(400, "invalid_expires_in_hours");
  }

  const node = await env.DB.prepare(
    "SELECT node_id, status, last_seen_at, " +
    "CASE WHEN last_seen_at IS NOT NULL " +
    "AND datetime(last_seen_at) >= datetime('now', '-5 minutes') THEN 1 ELSE 0 END AS recently_seen " +
    "FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();
  if (!node) {
    throw new ApiError(404, "node_not_found");
  }
  if (node.status === "revoked") {
    throw new ApiError(409, "node_revoked");
  }
  if (node.status === "paused") {
    throw new ApiError(409, "node_paused");
  }
  if (node.status !== "online" || Number(node.recently_seen || 0) !== 1) {
    throw new ApiError(409, "node_offline");
  }

  const missionId = "mission_" + crypto.randomUUID();
  const assignmentId = "assignment_" + crypto.randomUUID();
  const payloadJson = JSON.stringify({
    task_text: taskText,
    collect: ["language", "timezone", "screen_size"],
    network_access: false
  });
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const detailsJson = JSON.stringify({
    assignment_id: assignmentId,
    node_id: nodeId,
    mission_type: missionType
  });

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO missions (" +
      "mission_id, title, role_name, mission_type, payload_json, " +
      "priority, status, expires_at" +
      ") VALUES (?, ?, 'architect-test', ?, ?, ?, 'assigned', ?)"
    ).bind(
      missionId,
      title,
      missionType,
      payloadJson,
      priority,
      expiresAt
    ),
    env.DB.prepare(
      "INSERT INTO assignments (" +
      "assignment_id, mission_id, node_id, status" +
      ") VALUES (?, ?, ?, 'assigned')"
    ).bind(assignmentId, missionId, nodeId),
    env.DB.prepare(
      "INSERT INTO audit_events (" +
      "actor_type, actor_id, action, target_type, target_id, details_json" +
      ") VALUES ('architect', 'test-console', 'mission.created', 'mission', ?, ?)"
    ).bind(missionId, detailsJson)
  ]);

  return json({
    ok: true,
    mission: {
      mission_id: missionId,
      assignment_id: assignmentId,
      node_id: nodeId,
      mission_type: missionType,
      task_text: taskText,
      status: "assigned",
      expires_at: expiresAt
    }
  }, 201);
}

function apiDescription() {
  return json({
    ok: true,
    service: "citadel-ai",
    api_version: "v1",
    authentication: "CITADEL-Ed25519",
    mission_types: ["system_inventory"],
    command_types: ["pause", "resume", "update", "restart", "stop", "rollback", "uninstall", "system_reboot", "system_shutdown", "wake_peer", "lmstudio_install", "lmstudio_probe", "lmstudio_model_get", "lmstudio_model_load", "hybrid_query"],
    arbitrary_remote_execution: false
  });
}

async function handleApi(request, env, url) {
  if (url.pathname === "/api/health") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }

    try {
      const row = await env.DB.prepare("SELECT 1 AS ok").first();
      const [controllerSigning, reportStorage, sessionStorage] = await Promise.all([
        importControllerPrivateKey(env)
          .then(() => "ready")
          .catch(() => "unavailable"),
        ensureReportStorage(env)
          .then(() => "ready")
          .catch(() => "unavailable"),
        ensureSessionStorage(env)
          .then(() => "ready")
          .catch(() => "unavailable")
      ]);
      return json({
        ok: row?.ok === 1 &&
          controllerSigning === "ready" &&
          reportStorage === "ready" &&
          sessionStorage === "ready",
        service: "citadel-ai",
        database: "citadel-control",
        controller_signing: controllerSigning,
        report_storage: reportStorage,
        session_storage: sessionStorage
      });
    } catch {
      return json({
        ok: false,
        service: "citadel-ai",
        database: "unavailable"
      }, 503);
    }
  }

  if (url.pathname === "/api/v1/architect/experience") {
    return request.method === "GET"
      ? architectExperience(request, env)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/security/recover-token") {
    return request.method === "POST"
      ? architectRecoverToken(request, env)
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/security/sync-bootstrap-reset") {
    return request.method === "POST"
      ? architectSyncBootstrapReset(request, env)
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/security") {
    return request.method === "GET"
      ? architectSecurityStatus(request, env)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/security/recovery-code") {
    return request.method === "POST"
      ? architectCreateRecoveryCode(request, env)
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/security/rotate-token") {
    return request.method === "POST"
      ? architectRotateToken(request, env)
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/overview") {
    return request.method === "GET"
      ? architectOverview(request, env)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/release") {
    return request.method === "GET"
      ? architectRelease(request, env)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/update-all") {
    return request.method === "POST"
      ? startUpdateAllRollout(request, env)
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/models/search") {
    return request.method === "GET"
      ? architectSearchModels(request, env, url)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/work-roles") {
    return request.method === "GET"
      ? architectWorkRoles(request, env)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/projects/check") {
    return request.method === "POST"
      ? architectCheckProject(request, env)
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/projects") {
    if (request.method === "POST") return architectCreateProject(request, env);
    if (request.method === "GET") return architectListProjects(request, env);
    return methodNotAllowed(["GET", "POST"]);
  }

  const architectProjectMatch = url.pathname.match(
    /^\/api\/v1\/architect\/projects\/([^/]+)$/
  );
  if (architectProjectMatch) {
    return request.method === "GET"
      ? architectGetProject(request, env, decodeURIComponent(architectProjectMatch[1]))
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/hub/nodes") {
    return request.method === "GET"
      ? publicHubNodes(env)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/missions") {
    return request.method === "POST"
      ? architectCreateMission(request, env)
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/reports") {
    return request.method === "GET"
      ? architectListReports(request, env, url)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/storage") {
    return request.method === "GET"
      ? architectStorageUsage(request, env)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/sessions") {
    if (request.method === "GET") {
      return architectListSessions(request, env, url);
    }
    if (request.method === "POST") {
      return architectCreateSession(request, env);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  const architectSessionMatch = url.pathname.match(
    /^\/api\/v1\/architect\/sessions\/([^/]+)$/
  );
  if (architectSessionMatch) {
    const sessionId = decodeURIComponent(architectSessionMatch[1]);
    if (request.method === "GET") {
      return architectGetSession(request, env, sessionId);
    }
    if (request.method === "PATCH") {
      return architectUpdateSession(request, env, sessionId);
    }
    if (request.method === "DELETE") {
      return architectDeleteSession(request, env, sessionId);
    }
    return methodNotAllowed(["GET", "PATCH", "DELETE"]);
  }

  const architectReportMatch = url.pathname.match(
    /^\/api\/v1\/architect\/reports\/([^/]+)$/
  );
  if (architectReportMatch) {
    return request.method === "GET"
      ? architectGetReport(
          request,
          env,
          decodeURIComponent(architectReportMatch[1])
        )
      : methodNotAllowed(["GET"]);
  }

  const architectAiStateMatch = url.pathname.match(
    /^\/api\/v1\/architect\/nodes\/([^/]+)\/ai-state$/
  );
  if (architectAiStateMatch) {
    return request.method === "GET"
      ? architectNodeAiState(request, env, decodeURIComponent(architectAiStateMatch[1]))
      : methodNotAllowed(["GET"]);
  }

  const architectWakeMatch = url.pathname.match(
    /^\/api\/v1\/architect\/nodes\/([^/]+)\/wake$/
  );
  if (architectWakeMatch) {
    return request.method === "POST"
      ? architectWakeNode(request, env, decodeURIComponent(architectWakeMatch[1]))
      : methodNotAllowed(["POST"]);
  }

  const architectMatch = url.pathname.match(
    /^\/api\/v1\/architect\/nodes\/([^/]+)\/commands$/
  );
  if (architectMatch) {
    return request.method === "POST"
      ? architectCreateCommand(
          request,
          env,
          decodeURIComponent(architectMatch[1])
        )
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1") {
    return request.method === "GET"
      ? apiDescription()
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/enroll") {
    return request.method === "POST"
      ? enrollNode(request, env)
      : methodNotAllowed(["POST"]);
  }

  let match = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/heartbeat$/);
  if (match) {
    return request.method === "POST"
      ? heartbeat(request, env, decodeURIComponent(match[1]), url)
      : methodNotAllowed(["POST"]);
  }

  match = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/ai-state$/);
  if (match) {
    return request.method === "POST"
      ? nodeUpdateAiState(request, env, decodeURIComponent(match[1]), url)
      : methodNotAllowed(["POST"]);
  }

  match = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/assignments$/);
  if (match) {
    return request.method === "GET"
      ? listAssignments(request, env, decodeURIComponent(match[1]), url)
      : methodNotAllowed(["GET"]);
  }

  match = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/assignments\/([^/]+)\/accept$/);
  if (match) {
    return request.method === "POST"
      ? acceptAssignment(
          request,
          env,
          decodeURIComponent(match[1]),
          decodeURIComponent(match[2]),
          url
        )
      : methodNotAllowed(["POST"]);
  }

  match = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/results$/);
  if (match) {
    return request.method === "POST"
      ? submitResult(request, env, decodeURIComponent(match[1]), url)
      : methodNotAllowed(["POST"]);
  }

  match = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/commands$/);
  if (match) {
    return request.method === "GET"
      ? listCommands(request, env, decodeURIComponent(match[1]), url)
      : methodNotAllowed(["GET"]);
  }

  match = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/commands\/([^/]+)\/ack$/);
  if (match) {
    return request.method === "POST"
      ? acknowledgeCommand(
          request,
          env,
          decodeURIComponent(match[1]),
          decodeURIComponent(match[2]),
          url
        )
      : methodNotAllowed(["POST"]);
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export {
  classifyWorkRole,
  projectWorkerProfile,
  planProjectWork,
  projectFinalText
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleApi(request, env, url);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ ok: false, error: error.code }, error.status);
      }

      console.error("Unhandled API error", error);
      return json({ ok: false, error: "internal_error" }, 500);
    }
  }
};
