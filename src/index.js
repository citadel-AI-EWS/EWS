import { getProjectExperienceRegistry } from "./experience/registry.js";
import { d1UsageOverview, d1UsageStatus } from "./d1-usage.js";
import {d1QuotaResponse} from './d1-availability.js';
import { readD1RetentionStatus } from "./d1-retention.js";
import { readD1GuardianStatus, runD1Guardian } from "./d1-guardian.js";
import { openRouterQualityConfig, reviewWithOpenRouter } from "./quality/openrouter.js";
import { ARCHITECT_ROLE_PERMISSIONS, DEFAULT_ENTERPRISE_POLICY, evaluateEnterpriseNode, normalizeEnterprisePolicy, requiredArchitectPermission, roleHasPermission } from "./enterprise/policy.js";
import { buildAgentCapabilityContract, buildTaskEnvelope, buildResultEnvelope, verifyProjectResultEnvelope } from "./agent-contracts.js";
import {issueSshTicket, verifySshTicket, issueSshRelayTicket, verifySshRelayTicket} from "./ssh/tickets.js";
import {DIAGNOSTIC_NODE_HASH, DIAGNOSTIC_RECOVERY_END, expiredDiagnosticResumeEligible, DIAGNOSTIC_RESUME_REQUEUE_SQL} from './diagnostic-pause-recovery.js';
import {recoverPatchedRollout} from './patched-rollout-recovery.js';
import {replayFailureCode} from './replay-diagnostics.js';

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
const NODE_LIVE_WINDOW_MINUTES = 5;
const NODE_STALE_AFTER_MINUTES = 24 * 60;
const NODE_ARCHIVE_AFTER_MINUTES = 7 * 24 * 60;
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
const ALLOWED_COMMAND_ACKS = new Set(["accepted", "completed", "failed", "cancelled"]);
const ALLOWED_ARCHITECT_MISSION_TYPES = new Set(["system_inventory"]);
const SSH_CONSOLE_COMMANDS = new Set([
  "help", "status", "hostname", "whoami", "uname -a", "python --version", "python3 --version",
  "uptime", "cpu", "memory", "disk", "network",
  "agent-status", "agent-logs", "lmstudio-status", "diagnostics", "ping-controller", "exit"
]);
const MAX_SSH_CONSOLE_OUTPUT_BYTES = 24 * 1024;
const SSH_CONSOLE_RESULT_RETENTION_HOURS = 24;
const SSH_CONSOLE_RESULT_CLEANUP_BATCH = 250;
const ALLOWED_ARCHITECT_COMMAND_TYPES = new Set(["pause", "resume", "update", "restart", "stop", "rollback", "uninstall", "system_reboot", "system_shutdown", "lmstudio_install", "lmstudio_uninstall", "lmstudio_probe", "lmstudio_model_get", "lmstudio_model_load", "hybrid_query", "ssh_probe", "ssh_console"]);
const COMMAND_CONFIRMATIONS = Object.freeze({ system_reboot: "REBOOT", system_shutdown: "SHUTDOWN", lmstudio_uninstall: "REMOVE_LMSTUDIO" });
const WAKE_PEER_MIN_AGENT_VERSION = "0.3.6";
const LATEST_NODE_RELEASE = Object.freeze({
  version: "0.3.41",
  files: [
    {
      path: "citadel_node_v1.py",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/5f5737500394c24ac5ea065034f410680be2f700/agent/citadel_node_v1.py",
      sha256: "4e4c27d0f3b46e4024c89b205b6192dce31f3a3837e8e88777e3fc4cfefa2a76"
    },
    {
      path: "citadel_node_v2.py",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/5f5737500394c24ac5ea065034f410680be2f700/agent/citadel_node_v2.py",
      sha256: "c29864aefe5443073ce8bf29ffc3e20c7494a4fd2d8ad454a95f5b6b1ce14a05"
    },
    {
      path: "CitadelSshConsole.cs",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/64139abefcbc8daf161dc34a896163f52f899469/agent/CitadelSshConsole.cs",
      sha256: "56476adfd0d1fe343490c5abbf3663fb24152694e62c97c571cec29917ee21bf"
    },
    {
      path: "configure_restricted_ssh.ps1",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/64139abefcbc8daf161dc34a896163f52f899469/agent/configure_restricted_ssh.ps1",
      sha256: "e8d5be7e56a01e6e7fb4d2e8b02644b4f2082d0f1633dd5e30f59aae7f1dec73"
    }
  ]
});
const LEGACY_031_BRIDGE_RELEASE = Object.freeze({
  version: "0.3.2-bridge.1",
  files: Object.freeze([
    Object.freeze({
      path: "citadel_node_v1.py",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/0e168af8c39baad7c9157a732562dade0c58f12c/agent/citadel_node_v1.py",
      sha256: "4a5638a410ca689141a9a4c81d4e2d109c8cf2904e62df50ec6753f4146f5b37"
    }),
    Object.freeze({
      path: "citadel_node_v2.py",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/0e168af8c39baad7c9157a732562dade0c58f12c/agent/citadel_node_v2.py",
      sha256: "18fe495f2a46882e5c6c0172d217898d7374177c04b391a34931061b36342b6d"
    })
  ])
});
const LEGACY_CORE_UPDATE_FILES = new Set(["citadel_node_v1.py", "citadel_node_v2.py"]);
const LEGACY_ENTERPRISE_UPDATE_FILES = new Set([...LEGACY_CORE_UPDATE_FILES, "windows_enterprise_probe.ps1"]);

export function releaseForAgentVersion(release, agentVersion) {
  if (!agentVersionAtLeast(agentVersion, "0.3.2") &&
      release?.version !== LEGACY_031_BRIDGE_RELEASE.version) {
    return LEGACY_031_BRIDGE_RELEASE;
  }
  const allowed = agentVersionAtLeast(agentVersion, "0.3.27")
    ? null
    : agentVersionAtLeast(agentVersion, "0.3.13")
      ? LEGACY_ENTERPRISE_UPDATE_FILES
      : LEGACY_CORE_UPDATE_FILES;
  return {
    version: release.version,
    files: (release.files || []).filter((file) => !allowed || allowed.has(file.path))
  };
}

function updatePayloadCompatibleWithAgent(payload, agentVersion) {
  return Array.isArray(payload?.files) && payload.files.length > 0 &&
    releaseForAgentVersion(payload, agentVersion).files.length === payload.files.length;
}
export function updatePayloadReadyForAgent(payload, agentVersion) {
  const expectedRelease = releaseForAgentVersion(LATEST_NODE_RELEASE, agentVersion);
  if (payload?.version !== expectedRelease.version ||
      !updatePayloadCompatibleWithAgent(payload, agentVersion)) return false;
  const expected = expectedRelease.files;
  return payload.files.length === expected.length && expected.every((file) =>
    payload.files.some((candidate) => candidate.path === file.path &&
      candidate.url === file.url && candidate.sha256 === file.sha256));
}
const LMSTUDIO_INTEGRATION = Object.freeze({
  github_url: "https://github.com/citadel-AI-EWS/EWS/tree/main/agent/lmstudio",
  official_url: "https://lmstudio.ai",
  server_url: "http://127.0.0.1:1234",
  windows_asset: Object.freeze({
    path: "install_llmstudio_headless.ps1",
    url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/lmstudio/install_llmstudio_headless.ps1",
    sha256: "5daa9c0d34e57cb03e83b0984585a665fbbafc14df971b4154f94b6d235b8a3a"
  }),
  linux_asset: Object.freeze({
    path: "install_llmstudio_headless.sh",
    url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/lmstudio/install_llmstudio_headless.sh",
    sha256: "3d112dfa579562953919cfeccb6203d86333a99a473aaf4b76bdd2c39b70f67b"
  }),
  model_presets: Object.freeze([
    { id: "ibm/granite-4-micro", label: "IBM Granite 4 Micro" },
    { id: "openai/gpt-oss-20b", label: "OpenAI GPT-OSS 20B" }
  ])
});
const CONTROLLER_COMMAND_PUBLIC_X = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0";
const DEFAULT_GOOGLE_DRIVE_PAYLOAD_FOLDER_ID = "135_YkqQRJpkM1gmk_oh2uV8ldROqVmbn";
const DEFAULT_GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID = "1cUOu0FFbMMaf32tvPMK0bgsFsLyVAyTn";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE_POINTER_PREFIX = "@drive:";
let driveAccessTokenCache = { token: null, expires_at_ms: 0, source_key: null };
let payloadSchemaPromise;
let reportSchemaPromise;
let legacyReportBackfillPromise;
let sessionSchemaPromise;
let commandIndexPromise;
let commandReadIndexPromise;
let nodeNetworkSchemaPromise;
let nodeHardwareSchemaPromise;
let nodeSshSchemaPromise;
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

function normalizeSshConsoleCommand(value) {
  const command = requireString(value, "ssh_console_command", 32);
  if (!SSH_CONSOLE_COMMANDS.has(command)) {
    throw new ApiError(400, "ssh_console_command_not_allowed");
  }
  return command;
}

function normalizeSshConsoleResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_ssh_console_result");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["output", "exit_code"].includes(key))) {
    throw new ApiError(400, "invalid_ssh_console_result");
  }
  if (typeof value.output !== "string") {
    throw new ApiError(400, "invalid_ssh_console_output");
  }
  const outputBytes = new TextEncoder().encode(value.output).length;
  if (outputBytes > MAX_SSH_CONSOLE_OUTPUT_BYTES) {
    throw new ApiError(413, "ssh_console_output_too_large");
  }
  const exitCode = Number(value.exit_code);
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new ApiError(400, "invalid_ssh_console_exit_code");
  }
  return { output: value.output, exit_code: exitCode };
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
    mac_addresses: macAddresses
  };
}

function normalizeNodeHardware(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_hardware");
  }
  const memoryTotal = Number(value.memory_total_bytes);
  const cpuLogical = Number(value.cpu_logical_count);
  if (!Number.isSafeInteger(memoryTotal) || memoryTotal < 256 * 1024 * 1024 || memoryTotal > 4 * 1024 ** 5) {
    throw new ApiError(400, "invalid_hardware_memory");
  }
  if (!Number.isInteger(cpuLogical) || cpuLogical < 1 || cpuLogical > 4096) {
    throw new ApiError(400, "invalid_hardware_cpu");
  }
  const rawGpus = value.gpus === undefined ? [] : value.gpus;
  if (!Array.isArray(rawGpus) || rawGpus.length > 8) throw new ApiError(400, "invalid_hardware_gpus");
  const gpus = rawGpus.map((gpu) => {
    if (!gpu || typeof gpu !== "object" || Array.isArray(gpu)) throw new ApiError(400, "invalid_hardware_gpu");
    const name = requireString(gpu.name, "gpu_name", 160);
    const rawVram = gpu.vram_total_bytes;
    let vramTotalBytes = null;
    if (rawVram !== undefined && rawVram !== null) {
      const parsed = Number(rawVram);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1024 ** 5) {
        throw new ApiError(400, "invalid_hardware_vram");
      }
      vramTotalBytes = parsed;
    }
    return { name, vram_total_bytes: vramTotalBytes };
  });
  return {
    memory_total_bytes: memoryTotal,
    cpu_logical_count: cpuLogical,
    gpus
  };
}


function normalizeNodeSsh(value, osName = "") {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_ssh_state");
  }
  const bool = (field) => value[field] === true ? 1 : 0;
  const bindTarget = value.bind_target === undefined
    ? "localhost:22"
    : requireString(value.bind_target, "ssh_bind_target", 80);
  if (bindTarget !== "localhost:22" && bindTarget !== "127.0.0.1:22") {
    throw new ApiError(400, "invalid_ssh_bind_target");
  }
  const exposureVerified = bool("sshd_exposure_verified");
  const loopbackOnly = bool("sshd_loopback_only");
  const cloudflaredRunning = bool("cloudflared_running");
  const localListen = bool("sshd_listening_local");
  const restrictedBootstrapState = bool("restricted_bootstrap_state_present");
  const restrictedConsoleInstalled = bool("restricted_console_installed");
  const cloudflareCaPresent = bool("cloudflare_ca_public_key_present");
  const forceCommandManaged = bool("sshd_force_command_managed");
  const restrictedPolicyReady =
    restrictedBootstrapState && restrictedConsoleInstalled && cloudflareCaPresent && forceCommandManaged ? 1 : 0;
  const windowsPolicyRequired = String(osName || "").toLowerCase() === "windows";
  return {
    ssh_client_available: bool("ssh_client_available"),
    sshd_process_running: bool("sshd_process_running"),
    sshd_listening_local: localListen,
    sshd_exposure_verified: exposureVerified,
    sshd_loopback_only: loopbackOnly,
    cloudflared_installed: bool("cloudflared_installed"),
    cloudflared_running: cloudflaredRunning,
    restricted_bootstrap_state_present: restrictedBootstrapState,
    restricted_console_installed: restrictedConsoleInstalled,
    cloudflare_ca_public_key_present: cloudflareCaPresent,
    sshd_force_command_managed: forceCommandManaged,
    restricted_policy_ready: restrictedPolicyReady,
    browser_terminal_local_ready:
      localListen && exposureVerified && loopbackOnly && cloudflaredRunning &&
      (!windowsPolicyRequired || restrictedPolicyReady === 1) &&
      value.browser_terminal_local_ready === true ? 1 : 0,
    bind_target: bindTarget
  };
}

function normalizeSshPublicHostname(value) {
  const host = requireString(value, "ssh_public_hostname", 253).toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new ApiError(400, "invalid_ssh_public_hostname");
  }
  return host;
}

function normalizeSshUser(value) {
  const user = requireString(value, "ssh_user", 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(user)) {
    throw new ApiError(400, "invalid_ssh_user");
  }
  return user;
}

function normalizeSshFingerprint(value) {
  if (value === undefined || value === null || value === "") return null;
  const fingerprint = requireString(value, "ssh_host_key_fingerprint", 160);
  if (!/^SHA256:[A-Za-z0-9+/=]{20,120}$/.test(fingerprint)) {
    throw new ApiError(400, "invalid_ssh_host_key_fingerprint");
  }
  return fingerprint;
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

function agentVersionAtLeast(version, minimum) {
  const parse = (value) => {
    const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const actual = parse(version);
  const required = parse(minimum);
  if (!actual || !required) return false;
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}

export function wakeRelayEligible(node, now = Date.now()) {
  const seenAt = parseControllerTimestamp(node?.last_seen_at);
  return node?.status === "online" && Boolean(node.lan_ipv4) &&
    agentVersionAtLeast(node.agent_version, WAKE_PEER_MIN_AGENT_VERSION) &&
    seenAt !== null && seenAt >= now - NODE_LIVE_WINDOW_MINUTES * 60 * 1000;
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


function googleDrivePayloadConfig(env) {
  const clientId = typeof env.GOOGLE_DRIVE_CLIENT_ID === "string" ? env.GOOGLE_DRIVE_CLIENT_ID.trim() : "";
  const clientSecret = typeof env.GOOGLE_DRIVE_CLIENT_SECRET === "string" ? env.GOOGLE_DRIVE_CLIENT_SECRET.trim() : "";
  const refreshToken = typeof env.GOOGLE_DRIVE_REFRESH_TOKEN === "string" ? env.GOOGLE_DRIVE_REFRESH_TOKEN.trim() : "";
  const accessToken = typeof env.GOOGLE_DRIVE_ACCESS_TOKEN === "string" ? env.GOOGLE_DRIVE_ACCESS_TOKEN.trim() : "";
  const serviceAccountJson = typeof env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON === "string"
    ? env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON.trim()
    : "";
  const folderId = typeof env.GOOGLE_DRIVE_REPORTS_FOLDER_ID === "string" && env.GOOGLE_DRIVE_REPORTS_FOLDER_ID.trim()
    ? env.GOOGLE_DRIVE_REPORTS_FOLDER_ID.trim()
    : DEFAULT_GOOGLE_DRIVE_PAYLOAD_FOLDER_ID;
  return {
    folder_id: folderId,
    access_token: accessToken,
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    service_account_json: serviceAccountJson,
    configured: Boolean(folderId && (
      accessToken ||
      (clientId && clientSecret && refreshToken) ||
      serviceAccountJson
    ))
  };
}

function googleDriveServiceAccount(config) {
  if (!config.service_account_json) return null;
  let value;
  try {
    value = JSON.parse(config.service_account_json);
    if (typeof value === "string") value = JSON.parse(value.trim());
  } catch {
    throw new ApiError(503, "drive_payload_auth_failed");
  }
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    value.type !== "service_account" ||
    typeof value.client_email !== "string" ||
    !/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(value.client_email) ||
    typeof value.private_key !== "string" ||
    !value.private_key.includes("-----BEGIN PRIVATE KEY-----") ||
    !value.private_key.includes("-----END PRIVATE KEY-----")
  ) {
    throw new ApiError(503, "drive_payload_auth_failed");
  }
  if (value.token_uri && value.token_uri !== GOOGLE_OAUTH_TOKEN_URL) {
    throw new ApiError(503, "drive_payload_auth_failed");
  }
  return {
    client_email: value.client_email,
    private_key: value.private_key,
    token_uri: GOOGLE_OAUTH_TOKEN_URL
  };
}

function googleServiceAccountPkcs8(privateKey) {
  const base64 = String(privateKey)
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw new ApiError(503, "drive_payload_auth_failed");
  }
  try {
    const decoded = atob(base64);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new ApiError(503, "drive_payload_auth_failed");
  }
}

function googleJwtSegment(value) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function googleDriveServiceAccountToken(serviceAccount) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = googleJwtSegment({ alg: "RS256", typ: "JWT" });
  const claim = googleJwtSegment({
    iss: serviceAccount.client_email,
    scope: GOOGLE_DRIVE_SCOPE,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600
  });
  const signingInput = header + "." + claim;
  let key;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      googleServiceAccountPkcs8(serviceAccount.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch {
    throw new ApiError(503, "drive_payload_auth_failed");
  }
  let signature;
  try {
    signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput)
    );
  } catch {
    throw new ApiError(503, "drive_payload_auth_failed");
  }
  const assertion = signingInput + "." + bytesToBase64Url(signature);
  let response;
  try {
    response = await driveReportFetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      })
    });
  } catch {
    throw new ApiError(503, "drive_payload_storage_unavailable");
  }
  if (!response.ok) throw new ApiError(503, "drive_payload_auth_failed");
  const data = await response.json().catch(() => ({}));
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new ApiError(503, "drive_payload_auth_failed");
  }
  return {
    token: data.access_token,
    expires_in: Math.max(300, Number(data.expires_in || 3600))
  };
}

function googleDriveAiReportsFolderId(env) {
  const configured = typeof env.GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID === "string"
    ? env.GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID.trim()
    : "";
  return configured || DEFAULT_GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID;
}

function sanitizeDriveFolderName(value) {
  const normalized = String(value || "unknown-node")
    .replace(/[\\/\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 120);
  return normalized || "unknown-node";
}

function driveQueryLiteral(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function ensureDriveChildFolder(env, token, parentId, name) {
  const safeName = sanitizeDriveFolderName(name);
  const query = [
    "'" + driveQueryLiteral(parentId) + "' in parents",
    "trashed = false",
    "mimeType = 'application/vnd.google-apps.folder'",
    "name = '" + driveQueryLiteral(safeName) + "'"
  ].join(" and ");
  let response;
  try {
    response = await driveReportFetch(
      "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(query) +
      "&spaces=drive&pageSize=10&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true",
      { headers: { authorization: "Bearer " + token } }
    );
  } catch {
    throw new ApiError(503, "drive_payload_upload_failed");
  }
  if (!response.ok) throw await driveReportError(response);
  const found = await response.json().catch(() => ({}));
  const existing = Array.isArray(found.files)
    ? found.files.find((item) => item && item.name === safeName && typeof item.id === "string")
    : null;
  if (existing?.id) return existing.id;

  try {
    response = await driveReportFetch("https://www.googleapis.com/drive/v3/files?fields=id,name&supportsAllDrives=true", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: safeName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId]
      })
    });
  } catch {
    throw new ApiError(503, "drive_payload_upload_failed");
  }
  if (!response.ok) throw await driveReportError(response);
  const created = await response.json().catch(() => ({}));
  if (typeof created.id !== "string" || !created.id) {
    throw new ApiError(503, "drive_payload_upload_failed");
  }
  return created.id;
}

export function timestampedAiReportFileName(kind, ownerId, date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
  const safeKind = String(kind || "ai_response").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 48);
  const safeOwner = String(ownerId || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  return stamp + "__" + safeKind + "__" + safeOwner + ".json";
}

async function googleDriveAccessToken(env) {
  const config = googleDrivePayloadConfig(env);
  if (!config.configured) throw new ApiError(503, "drive_payload_storage_unavailable");
  if (config.access_token) return config.access_token;

  const oauthConfigured = Boolean(config.client_id && config.client_secret && config.refresh_token);
  const serviceAccount = oauthConfigured ? null : googleDriveServiceAccount(config);
  // Cache tokens by credential fingerprint so rotation takes effect immediately.
  const sourceKey = oauthConfigured
    ? "oauth:" + await sha256Hex(JSON.stringify([config.client_id, config.client_secret, config.refresh_token]))
    : serviceAccount
      ? "service:" + await sha256Hex(JSON.stringify([serviceAccount.client_email, serviceAccount.private_key]))
      : null;
  if (
    sourceKey &&
    driveAccessTokenCache.source_key === sourceKey &&
    driveAccessTokenCache.token &&
    Date.now() < driveAccessTokenCache.expires_at_ms - 60000
  ) {
    return driveAccessTokenCache.token;
  }

  let tokenData;
  if (oauthConfigured) {
    const body = new URLSearchParams({
      client_id: config.client_id,
      client_secret: config.client_secret,
      refresh_token: config.refresh_token,
      grant_type: "refresh_token"
    });
    let response;
    try {
      response = await driveReportFetch(GOOGLE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body
      });
    } catch {
      throw new ApiError(503, "drive_payload_storage_unavailable");
    }
    if (!response.ok) throw new ApiError(503, "drive_payload_auth_failed");
    const data = await response.json().catch(() => ({}));
    if (typeof data.access_token !== "string" || !data.access_token) {
      throw new ApiError(503, "drive_payload_auth_failed");
    }
    tokenData = {
      token: data.access_token,
      expires_in: Math.max(300, Number(data.expires_in || 3600))
    };
  } else if (serviceAccount) {
    tokenData = await googleDriveServiceAccountToken(serviceAccount);
  } else {
    throw new ApiError(503, "drive_payload_storage_unavailable");
  }

  driveAccessTokenCache = {
    token: tokenData.token,
    expires_at_ms: Date.now() + tokenData.expires_in * 1000,
    source_key: sourceKey
  };
  return tokenData.token;
}

async function googleDriveFolderWritable(token, folderId) {
  let response;
  try {
    response = await driveReportFetch(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(folderId) +
      "?fields=id,name,mimeType,capabilities(canEdit)&supportsAllDrives=true",
      { headers: { authorization: "Bearer " + token } }
    );
  } catch {
    throw new ApiError(503, "drive_payload_storage_unavailable");
  }
  if (response.status === 401) throw new ApiError(503, "drive_payload_auth_failed");
  if (response.status === 403) throw new ApiError(503, "drive_payload_write_denied");
  if (!response.ok) throw new ApiError(503, "drive_payload_storage_unavailable");
  const data = await response.json().catch(() => ({}));
  if (data.mimeType !== "application/vnd.google-apps.folder") {
    throw new ApiError(503, "drive_payload_storage_unavailable");
  }
  if (data.capabilities?.canEdit !== true) {
    throw new ApiError(503, "drive_payload_write_denied");
  }
  return { id: data.id || folderId, name: data.name || null };
}

export async function googleDriveWritablePreflight(env) {
  const token = await googleDriveAccessToken(env);
  const config = googleDrivePayloadConfig(env);
  const folders = [...new Set([
    config.folder_id,
    googleDriveAiReportsFolderId(env)
  ].filter(Boolean))];
  const checked = [];
  for (const folderId of folders) {
    checked.push(await googleDriveFolderWritable(token, folderId));
  }
  return { ok: true, folders: checked };
}

// Operational archives are enabled only by a write/readback proof for the
// currently selected credentials and destination. A token rotation invalidates
// the proof; no Google credential is sent to an agent or included in a report.
export async function googleDriveNodeReportFingerprint(env) {
  const config = googleDrivePayloadConfig(env);
  if (!config.configured) return null;
  const source = config.access_token ? ["access", config.access_token]
    : config.client_id && config.client_secret && config.refresh_token
      ? ["oauth", config.client_id, config.client_secret, config.refresh_token]
      : ["service", config.service_account_json];
  return sha256Hex(JSON.stringify([source, googleDriveAiReportsFolderId(env)]));
}

async function driveReportError(response) {
  const error = await response.json().catch(() => ({}));
  const reasons = error.error?.errors?.map(item => item.reason) || [];
  const code = response.status === 401 ? "drive_payload_auth_failed"
    : reasons.includes("storageQuotaExceeded") ? "drive_storage_quota_exceeded"
    : response.status === 403 ? "drive_payload_write_denied"
    : "drive_payload_upload_failed";
  return new ApiError(503, code);
}

async function driveReportFetch(url, init = {}) {
  try {
    return await fetch(url, {...init, signal: AbortSignal.timeout(15000)});
  } catch {
    throw new ApiError(503, "drive_payload_storage_unavailable");
  }
}

export async function googleDriveAllocateReportId(env) {
  const token = await googleDriveAccessToken(env);
  const response = await driveReportFetch(
    "https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files",
    {headers: {authorization: "Bearer " + token}}
  );
  if (!response.ok) throw await driveReportError(response);
  const data = await response.json();
  const id = data.ids?.[0];
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new ApiError(503, "drive_payload_upload_failed");
  }
  return id;
}

export async function googleDriveWriteNodeReport(env, report) {
  const token = await googleDriveAccessToken(env);
  const folderId = await ensureDriveChildFolder(env, token, googleDriveAiReportsFolderId(env),
    (report.node_name || report.node_id) + "__" + report.node_id);
  const metadata = {
    id: report.file_id,
    name: timestampedAiReportFileName("node_report", report.batch_id, new Date(report.created_at)),
    mimeType: "application/json",
    parents: [folderId],
    appProperties: {citadel_node_id: report.node_id, citadel_batch_id: report.batch_id,
      citadel_sha256: report.sha256}
  };
  const boundary = "citadel-report-" + crypto.randomUUID();
  const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) + "\r\n--" + boundary +
    "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + report.report_json +
    "\r\n--" + boundary + "--";
  const uploaded = await driveReportFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
    {method: "POST", headers: {authorization: "Bearer " + token,
      "content-type": "multipart/related; boundary=" + boundary}, body}
  );
  // A persisted, pre-generated file ID makes retries safe after a lost upload
  // response. A 409 is accepted only if the stored bytes match this report.
  if (!uploaded.ok && uploaded.status !== 409) throw await driveReportError(uploaded);
  if (uploaded.ok) {
    const value = await uploaded.json();
    if (value.id !== report.file_id) throw new ApiError(503, "drive_report_id_mismatch");
  }
  const downloaded = await driveReportFetch(
    "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(report.file_id) +
    "?alt=media&supportsAllDrives=true", {headers: {authorization: "Bearer " + token}}
  );
  if (!downloaded.ok) throw await driveReportError(downloaded);
  const bytes = new Uint8Array(await downloaded.arrayBuffer());
  if (bytes.length !== new TextEncoder().encode(report.report_json).length ||
      await sha256Hex(bytes) !== report.sha256) {
    throw new ApiError(503, "drive_report_readback_mismatch");
  }
  return {file_id: report.file_id, folder_id: folderId, sha256: report.sha256};
}

export async function googleDriveNodeReportWriteTest(env) {
  const fingerprint = await googleDriveNodeReportFingerprint(env);
  if (!fingerprint) throw new ApiError(503, "drive_credentials_missing");
  const createdAt = new Date().toISOString();
  const reportJson = JSON.stringify({schema: "citadel-node-report/v1", node_id: "drive-write-test",
    created_at: createdAt, events: [{event_type: "drive_write_test", message: "Проверка записи и чтения отчёта"}]});
  const sha = await sha256Hex(reportJson);
  const uploaded = await googleDriveWriteNodeReport(env, {
    file_id: await googleDriveAllocateReportId(env), node_id: "drive-write-test",
    node_name: "Проверка записи", batch_id: sha, sha256: sha,
    report_json: reportJson, created_at: createdAt
  });
  return {live_write_verified: true, fingerprint, checked_at: createdAt, ...uploaded};
}

async function recordOperationalReport(env, nodeId, eventType, details, createdAt = new Date().toISOString()) {
  if (typeof env.__CITADEL_REPORT_EVENT !== "function") return;
  try {
    await env.__CITADEL_REPORT_EVENT(nodeId, eventType, details, createdAt);
  } catch (error) {
    // Connection and command acknowledgement remain available if the archive
    // queue is unavailable. The signed /logs endpoint instead fails closed so
    // the agent retains its durable local telemetry cursor for retry.
    console.error("node_report_observer_failed", error?.code || "report_queue_unavailable");
  }
}

async function ensurePayloadStorage(env) {
  if (!payloadSchemaPromise) {
    payloadSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS payload_objects (
          payload_id TEXT PRIMARY KEY,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          drive_file_id TEXT NOT NULL UNIQUE,
          sha256 TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_payload_objects_owner
        ON payload_objects(owner_type, owner_id, kind, created_at)
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS interactive_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          work_item_id TEXT,
          node_id TEXT,
          role_name TEXT NOT NULL,
          execution_mode TEXT NOT NULL CHECK (execution_mode IN ('ai','python')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
          message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES architect_projects(project_id) ON DELETE CASCADE,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE SET NULL
        )
      `),
      env.DB.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_threads_project_work
        ON interactive_threads(project_id, work_item_id)
        WHERE work_item_id IS NOT NULL
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS interactive_messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
          actor TEXT NOT NULL CHECK (actor IN ('user','agent','system')),
          payload_id TEXT NOT NULL,
          response_work_item_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (thread_id) REFERENCES interactive_threads(thread_id) ON DELETE CASCADE,
          FOREIGN KEY (payload_id) REFERENCES payload_objects(payload_id) ON DELETE RESTRICT,
          UNIQUE (thread_id, sequence_no)
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_interactive_messages_thread
        ON interactive_messages(thread_id, sequence_no)
      `)
    ]).catch((error) => {
      payloadSchemaPromise = undefined;
      throw error;
    });
  }
  await payloadSchemaPromise;
}

function drivePointer(payloadId) {
  return DRIVE_POINTER_PREFIX + payloadId;
}

function drivePointerId(value) {
  if (typeof value !== "string" || !value.startsWith(DRIVE_POINTER_PREFIX)) return null;
  const payloadId = value.slice(DRIVE_POINTER_PREFIX.length).trim();
  return payloadId || null;
}

async function deleteDriveFileBestEffort(env, fileId) {
  if (!fileId) return true;
  try {
    const token = await googleDriveAccessToken(env);
    const response = await driveReportFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?supportsAllDrives=true", {
      method: "DELETE",
      headers: { authorization: "Bearer " + token }
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function deletePayloadBestEffort(env, payloadId) {
  if (!payloadId) return true;
  try {
    const row = await env.DB.prepare(
      "SELECT drive_file_id FROM payload_objects WHERE payload_id = ?"
    ).bind(payloadId).first();
    if (!row) return true;
    if (row.drive_file_id && !(await deleteDriveFileBestEffort(env, row.drive_file_id))) {
      return false;
    }
    await env.DB.prepare("DELETE FROM payload_objects WHERE payload_id = ?").bind(payloadId).run();
    return true;
  } catch {
    return false;
  }
}

async function persistDrivePayload(env, { owner_type, owner_id, kind, value, node_id = null }) {
  await ensurePayloadStorage(env);
  const config = googleDrivePayloadConfig(env);
  if (!config.configured) throw new ApiError(503, "drive_payload_storage_unavailable");
  const payloadId = "payload_" + crypto.randomUUID();
  const jsonText = JSON.stringify(value);
  const sizeBytes = new TextEncoder().encode(jsonText).byteLength;
  const sha256 = await sha256Hex(jsonText);
  const token = await googleDriveAccessToken(env);
  const safeOwner = String(owner_id || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  const safeKind = String(kind || "payload").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 48);
  let parentFolderId = config.folder_id;
  let fileName = safeOwner + "__" + safeKind + "__" + payloadId + ".json";
  if (node_id && ["agent_report", "ai_response"].includes(String(kind || ""))) {
    const node = await env.DB.prepare("SELECT hostname FROM nodes WHERE node_id = ?").bind(node_id).first();
    const nodeFolderName = sanitizeDriveFolderName(node?.hostname || node_id);
    parentFolderId = await ensureDriveChildFolder(
      env,
      token,
      googleDriveAiReportsFolderId(env),
      nodeFolderName
    );
    fileName = timestampedAiReportFileName(kind, owner_id);
  }
  const metadata = {
    name: fileName,
    parents: [parentFolderId],
    mimeType: "application/json",
    appProperties: {
      citadel_payload_id: payloadId,
      citadel_owner_type: String(owner_type || "").slice(0, 64),
      citadel_owner_id: String(owner_id || "").slice(0, 120),
      citadel_kind: String(kind || "").slice(0, 64),
      citadel_node_id: String(node_id || "").slice(0, 128),
      citadel_sha256: sha256
    }
  };
  const boundary = "citadel_" + crypto.randomUUID().replace(/-/g, "");
  const multipart =
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    jsonText + "\r\n" +
    "--" + boundary + "--";
  let response;
  try {
    response = await driveReportFetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size&supportsAllDrives=true",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "multipart/related; boundary=" + boundary
        },
        body: multipart
      }
    );
  } catch {
    throw new ApiError(503, "drive_payload_upload_failed");
  }
  if (!response.ok) throw new ApiError(503, "drive_payload_upload_failed");
  const uploaded = await response.json().catch(() => ({}));
  const fileId = typeof uploaded.id === "string" ? uploaded.id : "";
  if (!fileId) throw new ApiError(503, "drive_payload_upload_failed");
  try {
    await env.DB.prepare(`
      INSERT INTO payload_objects (
        payload_id, owner_type, owner_id, kind, drive_file_id, sha256, size_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(payloadId, owner_type, owner_id, kind, fileId, sha256, sizeBytes).run();
  } catch (error) {
    await deleteDriveFileBestEffort(env, fileId);
    throw error;
  }
  return { payload_id: payloadId, drive_file_id: fileId, sha256, size_bytes: sizeBytes };
}

async function readDrivePayload(env, payloadId) {
  await ensurePayloadStorage(env);
  const row = await env.DB.prepare(`
    SELECT payload_id, drive_file_id, sha256, size_bytes
    FROM payload_objects WHERE payload_id = ?
  `).bind(payloadId).first();
  if (!row) throw new ApiError(404, "payload_not_found");
  const token = await googleDriveAccessToken(env);
  let response;
  try {
    response = await driveReportFetch(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(row.drive_file_id) + "?alt=media&supportsAllDrives=true",
      { headers: { authorization: "Bearer " + token } }
    );
  } catch {
    throw new ApiError(503, "drive_payload_read_failed");
  }
  if (!response.ok) throw new ApiError(503, "drive_payload_read_failed");
  const text = await response.text();
  if ((new TextEncoder().encode(text).byteLength) !== Number(row.size_bytes)) {
    throw new ApiError(502, "drive_payload_size_mismatch");
  }
  if ((await sha256Hex(text)) !== row.sha256) {
    throw new ApiError(502, "drive_payload_hash_mismatch");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(502, "drive_payload_invalid_json");
  }
}

async function resolveDriveText(env, value) {
  const payloadId = drivePointerId(value);
  if (!payloadId) return String(value || "");
  const payload = await readDrivePayload(env, payloadId);
  if (typeof payload === "string") return payload;
  if (payload && typeof payload.text === "string") return payload.text;
  throw new ApiError(502, "drive_payload_missing_text");
}

async function resolveDriveJson(env, value) {
  const payloadId = drivePointerId(value);
  if (!payloadId) return safeJson(value, null);
  return readDrivePayload(env, payloadId);
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

async function ensureCommandReadIndexes(env) {
  if (!commandReadIndexPromise) {
    commandReadIndexPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_commands_status_created
        ON commands(status, created_at DESC, command_id DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_commands_created_time
        ON commands(datetime(created_at) DESC, command_id DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_commands_node_created_time
        ON commands(node_id, datetime(created_at) DESC, command_id DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_audit_events_target_action
        ON audit_events(target_type, target_id, action, event_id DESC)
      `)
    ]).catch((error) => {
      commandReadIndexPromise = undefined;
      throw error;
    });
  }
  await commandReadIndexPromise;
}

async function ensureCommandStorage(env) {
  if (!commandIndexPromise) {
    commandIndexPromise = (async () => {
      // Runtime-bootstrap the core command/audit tables as well as the index.
      // A partially initialized D1 must never turn LM Studio install into an
      // opaque 500 just because the migration history is incomplete.
      await env.DB.batch([
        env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS commands (
            command_id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL,
            command_type TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            signature TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT,
            FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
          )
        `),
        env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS ssh_console_results (
            command_id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL,
            output TEXT NOT NULL,
            exit_code INTEGER NOT NULL CHECK (exit_code BETWEEN 0 AND 255),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (command_id) REFERENCES commands(command_id) ON DELETE CASCADE,
            FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
          )
        `),
        env.DB.prepare(`
          CREATE INDEX IF NOT EXISTS idx_ssh_console_results_node_created
          ON ssh_console_results(node_id, created_at DESC)
        `),
        env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS audit_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_type TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            details_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `),
        env.DB.prepare(`
          CREATE INDEX IF NOT EXISTS idx_commands_node_status_created
          ON commands(node_id, status, created_at)
        `),
        env.DB.prepare(`
          CREATE INDEX IF NOT EXISTS idx_commands_status_created
          ON commands(status, created_at DESC, command_id DESC)
        `),
        env.DB.prepare(`
          CREATE INDEX IF NOT EXISTS idx_commands_created_time
          ON commands(datetime(created_at) DESC, command_id DESC)
        `),
        env.DB.prepare(`
          CREATE INDEX IF NOT EXISTS idx_audit_events_created
          ON audit_events(event_id DESC)
        `),
        env.DB.prepare(`
          CREATE INDEX IF NOT EXISTS idx_audit_events_target_action
          ON audit_events(target_type, target_id, action, event_id DESC)
        `)
      ]);

      // CREATE TABLE IF NOT EXISTS does not upgrade an already-existing legacy
      // commands table. Some early TEST databases predate completed_at, while
      // stale-command expiry and ACK handling both write that column. Repair
      // that schema drift in place before touching stale rows.
      const commandColumns = await env.DB.prepare("PRAGMA table_info(commands)").all();
      const commandColumnNames = new Set(
        (commandColumns.results || []).map((row) => String(row.name || ""))
      );
      if (!commandColumnNames.has("completed_at")) {
        try {
          await env.DB.prepare("ALTER TABLE commands ADD COLUMN completed_at TEXT").run();
        } catch (error) {
          // Concurrent requests can race the one-time repair. A duplicate-column
          // result means the other request already completed the same safe repair.
          if (!String(error).toLowerCase().includes("duplicate column")) throw error;
        }
      }

      // Existing TEST databases may contain an old pending/accepted command.
      // Drain stale rows before creating the partial UNIQUE index; otherwise
      // SQLite can reject index creation and surface an opaque internal_error.
      let expiredBatchSize;
      do {
        expiredBatchSize = await expireStaleCommands(env);
      } while (expiredBatchSize === 250);
      const createIndex = () => env.DB.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_one_active_per_node
        ON commands(node_id)
        WHERE status IN ('pending', 'accepted')
      `).run();

      try {
        await createIndex();
      } catch (error) {
        const message = String(error).toLowerCase();
        if (!message.includes("unique") && !message.includes("commands.node_id")) {
          throw error;
        }

        // Older deployments could contain more than one active command for the
        // same node before this invariant existed. Keep the newest active
        // command and mark older duplicates failed so the queue can recover
        // automatically instead of returning an opaque internal_error forever.
        await env.DB.prepare(`
          UPDATE commands
          SET status = 'failed',
              completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
          WHERE status IN ('pending', 'accepted')
            AND EXISTS (
              SELECT 1
              FROM commands AS newer
              WHERE newer.node_id = commands.node_id
                AND newer.status IN ('pending', 'accepted')
                AND (
                  datetime(newer.created_at) > datetime(commands.created_at)
                  OR (
                    datetime(newer.created_at) = datetime(commands.created_at)
                    AND newer.command_id > commands.command_id
                  )
                )
            )
        `).run();

        await createIndex();
        await env.DB.prepare(`
          INSERT INTO audit_events (
            actor_type, actor_id, action, target_type, target_id, details_json
          ) VALUES (
            'controller', 'command-storage-repair',
            'commands.active_duplicates_repaired',
            'commands', 'active',
            '{"policy":"keep_newest_active_per_node"}'
          )
        `).run();
      }
    })().catch((error) => {
      commandIndexPromise = undefined;
      throw error;
    });
  }
  await commandIndexPromise;
}

async function pruneExpiredSshConsoleResults(env) {
  const cutoff = new Date(Date.now() - SSH_CONSOLE_RESULT_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    DELETE FROM ssh_console_results
    WHERE command_id IN (
      SELECT command_id
      FROM ssh_console_results
      WHERE datetime(created_at) < datetime(?)
      ORDER BY created_at ASC
      LIMIT ?
    )
  `).bind(cutoff, SSH_CONSOLE_RESULT_CLEANUP_BATCH).run();
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

async function ensureNodeHardwareStorage(env) {
  if (!nodeHardwareSchemaPromise) {
    nodeHardwareSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS node_hardware_state (
          node_id TEXT PRIMARY KEY,
          memory_total_bytes INTEGER NOT NULL,
          cpu_logical_count INTEGER NOT NULL,
          gpus_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_hardware_updated
        ON node_hardware_state(updated_at DESC)
      `)
    ]).catch((error) => {
      nodeHardwareSchemaPromise = undefined;
      throw error;
    });
  }
  await nodeHardwareSchemaPromise;
}


async function ensureNodeSshStorage(env) {
  if (!nodeSshSchemaPromise) {
    nodeSshSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS node_ssh_state (
          node_id TEXT PRIMARY KEY,
          ssh_client_available INTEGER NOT NULL DEFAULT 0 CHECK (ssh_client_available IN (0,1)),
          sshd_process_running INTEGER NOT NULL DEFAULT 0 CHECK (sshd_process_running IN (0,1)),
          sshd_listening_local INTEGER NOT NULL DEFAULT 0 CHECK (sshd_listening_local IN (0,1)),
          sshd_exposure_verified INTEGER NOT NULL DEFAULT 0 CHECK (sshd_exposure_verified IN (0,1)),
          sshd_loopback_only INTEGER NOT NULL DEFAULT 0 CHECK (sshd_loopback_only IN (0,1)),
          cloudflared_installed INTEGER NOT NULL DEFAULT 0 CHECK (cloudflared_installed IN (0,1)),
          cloudflared_running INTEGER NOT NULL DEFAULT 0 CHECK (cloudflared_running IN (0,1)),
          restricted_bootstrap_state_present INTEGER NOT NULL DEFAULT 0 CHECK (restricted_bootstrap_state_present IN (0,1)),
          restricted_console_installed INTEGER NOT NULL DEFAULT 0 CHECK (restricted_console_installed IN (0,1)),
          cloudflare_ca_public_key_present INTEGER NOT NULL DEFAULT 0 CHECK (cloudflare_ca_public_key_present IN (0,1)),
          sshd_force_command_managed INTEGER NOT NULL DEFAULT 0 CHECK (sshd_force_command_managed IN (0,1)),
          restricted_policy_ready INTEGER NOT NULL DEFAULT 0 CHECK (restricted_policy_ready IN (0,1)),
          browser_terminal_local_ready INTEGER NOT NULL DEFAULT 0 CHECK (browser_terminal_local_ready IN (0,1)),
          bind_target TEXT NOT NULL DEFAULT 'localhost:22',
          public_hostname TEXT,
          ssh_user TEXT,
          host_key_fingerprint TEXT,
          config_updated_at TEXT,
          observed_at TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_ssh_ready
        ON node_ssh_state(browser_terminal_local_ready, updated_at DESC)
      `)
    ]).catch((error) => {
      nodeSshSchemaPromise = undefined;
      throw error;
    });
  }
  await nodeSshSchemaPromise;
}

async function nodeSshStateResponse(env, nodeId) {
  await ensureNodeSshStorage(env);
  const row = await env.DB.prepare(`
    SELECT node_id, ssh_client_available, sshd_process_running, sshd_listening_local,
      sshd_exposure_verified, sshd_loopback_only,
      cloudflared_installed, cloudflared_running,
      restricted_bootstrap_state_present, restricted_console_installed,
      cloudflare_ca_public_key_present, sshd_force_command_managed, restricted_policy_ready,
      browser_terminal_local_ready,
      bind_target, public_hostname, ssh_user, host_key_fingerprint,
      config_updated_at, observed_at, updated_at
    FROM node_ssh_state WHERE node_id = ?
  `).bind(nodeId).first();
  const state = row || {
    node_id: nodeId,
    ssh_client_available: 0,
    sshd_process_running: 0,
    sshd_listening_local: 0,
    sshd_exposure_verified: 0,
    sshd_loopback_only: 0,
    cloudflared_installed: 0,
    cloudflared_running: 0,
    restricted_bootstrap_state_present: 0,
    restricted_console_installed: 0,
    cloudflare_ca_public_key_present: 0,
    sshd_force_command_managed: 0,
    restricted_policy_ready: 0,
    browser_terminal_local_ready: 0,
    bind_target: "localhost:22",
    public_hostname: null,
    ssh_user: null,
    host_key_fingerprint: null,
    config_updated_at: null,
    observed_at: null,
    updated_at: null
  };
  return {
    ...state,
    browser_url: state.public_hostname ? "https://" + state.public_hostname : null,
    private_keys_stored: false
  };
}

function sshGatewayConfig(env) {
  const raw = String(env.SSH_GATEWAY_URL || "").trim();
  const secret = String(env.SSH_GATEWAY_TICKET_SECRET || "");
  if (!raw || secret.length < 32 || secret.length > 512 || /\s/.test(secret)) return null;
  try {
    const url = new URL(raw);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/ssh") return null;
    return {url: url.href, secret};
  } catch {return null;}
}

async function architectSshSession(request, env, nodeId) {
  const actor = await authenticateArchitect(request, env);
  if (request.method === "POST" && !roleHasPermission(actor.role, "admin")) throw new ApiError(403, "architect_admin_required");
  const node = await env.DB.prepare("SELECT node_id, hostname FROM nodes WHERE node_id = ? AND status != 'revoked'").bind(nodeId).first();
  if (!node) throw new ApiError(404, "node_not_found");
  const config = sshGatewayConfig(env);
  const relay = env.SSH_RELAY ? await relayStatus(env, nodeId) : null;
  const relayConnected = relay?.agent_connected === true;
  if (request.method === "GET") return json({ok: true, configured: Boolean(config || env.SSH_RELAY),
    can_connect: Boolean(config || relayConnected) && roleHasPermission(actor.role, "admin"),
    gateway_configured: Boolean(config), agent_connected: relayConnected, node_id: nodeId});
  if (!config && !relayConnected) throw new ApiError(503, "ssh_agent_not_connected");
  const body = parseJsonObject(await readBodyText(request, 256));
  if (Object.keys(body).length) throw new ApiError(400, "ssh_session_target_override_forbidden");
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(nodeId)) throw new ApiError(400, "invalid_node_id");
  const {ticket, claims} = relayConnected
    ? await issueSshRelayTicket(await relaySecret(env), {node_id: nodeId, actor_id: actor.actor_id})
    : await issueSshTicket(config.secret, {node_id: nodeId, actor_id: actor.actor_id});
  await env.DB.prepare(`INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json)
    VALUES ('architect', ?, 'ssh.session.issued', 'node', ?, ?)`)
    .bind(actor.actor_id, nodeId, JSON.stringify({session_id: claims.jti, expires_at: claims.session_exp})).run();
  return json({ok: true, node_id: nodeId, ticket,
    websocket_path: relayConnected ? "/api/v1/architect/ssh/relay/connect" : "/api/v1/architect/ssh/connect",
    ticket_expires_at: claims.exp * 1000});
}

function relayStub(env, nodeId) {
  if (!env.SSH_RELAY) throw new ApiError(503, 'ssh_relay_unavailable');
  return env.SSH_RELAY.get(env.SSH_RELAY.idFromName(nodeId));
}

async function relayStatus(env, nodeId) {
  try {
    const response = await relayStub(env, nodeId).fetch('https://relay.internal/status',
      {headers: {'x-citadel-relay-role': 'status'}});
    return response.ok ? response.json() : null;
  } catch {return null;}
}

async function relaySecret(env) {
  const state = await architectAuthState(env);
  return state.token_hash;
}

async function architectSshRelayConnect(request, env) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
      request.headers.get('origin') !== new URL(request.url).origin) throw new ApiError(403, 'ssh_origin_denied');
  const protocols = String(request.headers.get('sec-websocket-protocol') || '').split(',').map(value => value.trim());
  if (protocols.length !== 2 || protocols[0] !== 'citadel-ssh-v1' || !protocols[1].startsWith('ticket.')) {
    throw new ApiError(401, 'invalid_ssh_ticket');
  }
  let claims;
  try {claims = await verifySshRelayTicket(await relaySecret(env), protocols[1].slice(7));}
  catch {throw new ApiError(401, 'invalid_ssh_ticket');}
  const node = await env.DB.prepare("SELECT node_id FROM nodes WHERE node_id = ? AND status != 'revoked'").bind(claims.node_id).first();
  if (!node) throw new ApiError(404, 'node_not_found');
  const response = await relayStub(env, claims.node_id).fetch('https://relay.internal/attach', {headers: {
    upgrade: 'websocket', 'x-citadel-relay-role': 'browser',
    'x-citadel-relay-node-id': claims.node_id,
    'x-citadel-relay-jti': claims.jti, 'x-citadel-relay-ticket-expires': String(claims.exp),
    'x-citadel-relay-session-expires': String(claims.session_exp)}});
  if (response.status !== 101) throw new ApiError(503, 'ssh_agent_not_connected');
  return response;
}

async function nodeSshRelayConnect(request, env, nodeId, url) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
      request.headers.get('sec-websocket-protocol') !== 'citadel-ssh-agent-v1') {
    throw new ApiError(426, 'ssh_websocket_required');
  }
  await authenticateNode(request, env, nodeId, url, new Uint8Array(0));
  const response = await relayStub(env, nodeId).fetch('https://relay.internal/attach', {
    headers: {upgrade: 'websocket', 'x-citadel-relay-role': 'agent', 'x-citadel-relay-node-id': nodeId}});
  if (response.status !== 101) throw new ApiError(503, 'ssh_relay_unavailable');
  return response;
}

async function architectSshConnect(request, env) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new ApiError(426, "ssh_websocket_required");
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new ApiError(403, "ssh_origin_denied");
  const protocols = String(request.headers.get("sec-websocket-protocol") || "").split(",").map(s => s.trim());
  if (protocols.length !== 2 || protocols[0] !== "citadel-ssh-v1" || !protocols[1].startsWith("ticket.")) throw new ApiError(401, "invalid_ssh_ticket");
  const config = sshGatewayConfig(env);
  if (!config) throw new ApiError(503, "ssh_gateway_not_configured");
  const ticket = protocols[1].slice(7);
  let claims;
  try {claims = await verifySshTicket(config.secret, ticket);} catch {throw new ApiError(401, "invalid_ssh_ticket");}
  const node = await env.DB.prepare("SELECT node_id FROM nodes WHERE node_id = ? AND status != 'revoked'").bind(claims.node_id).first();
  if (!node) throw new ApiError(404, "node_not_found");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(config.url, {headers: {upgrade: "websocket", origin: new URL(request.url).origin,
      "sec-websocket-protocol": "citadel-ssh-v1", "x-citadel-ssh-ticket": ticket}, signal: controller.signal, redirect: "manual"});
    if (response.status !== 101 || !response.webSocket) {
      console.error("SSH gateway upgrade rejected", {status: response.status});
      throw new ApiError(503, "ssh_gateway_connection_failed");
    }
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error("SSH gateway connection failed", {name: String(error?.name || "Error")});
    throw new ApiError(503, "ssh_gateway_connection_failed");
  } finally {clearTimeout(timer);}
}

async function architectNodeSsh(request, env, nodeId) {
  const actor = await authenticateArchitect(request, env);
  const node = await env.DB.prepare(
    "SELECT node_id, status FROM nodes WHERE node_id = ? AND status != 'revoked'"
  ).bind(nodeId).first();
  if (!node) throw new ApiError(404, "node_not_found");
  await ensureNodeSshStorage(env);

  if (request.method === "GET") {
    return json({ ok: true, ssh: await nodeSshStateResponse(env, nodeId) });
  }
  if (request.method === "DELETE") {
    if (!roleHasPermission(actor.role, "admin")) throw new ApiError(403, "architect_admin_required");
    await env.DB.prepare(`
      UPDATE node_ssh_state
      SET public_hostname = NULL, ssh_user = NULL, host_key_fingerprint = NULL,
          config_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE node_id = ?
    `).bind(nodeId).run();
    return json({ ok: true, ssh: await nodeSshStateResponse(env, nodeId) });
  }
  if (request.method !== "PUT") return methodNotAllowed(["GET", "PUT", "DELETE"]);
  if (!roleHasPermission(actor.role, "operate")) throw new ApiError(403, "architect_operator_required");

  const body = parseJsonObject(await readBodyText(request, 4096));
  const allowedFields = new Set(["public_hostname", "ssh_user", "host_key_fingerprint"]);
  const unknownField = Object.keys(body).find((key) => !allowedFields.has(key));
  if (unknownField) {
    if (/private|password|secret|token|credential|passphrase/i.test(unknownField)) {
      throw new ApiError(400, "ssh_secret_material_not_allowed");
    }
    throw new ApiError(400, "invalid_ssh_config_field");
  }
  const publicHostname = normalizeSshPublicHostname(body.public_hostname);
  const sshUser = normalizeSshUser(body.ssh_user);
  const fingerprint = normalizeSshFingerprint(body.host_key_fingerprint);

  await env.DB.prepare(`
    INSERT INTO node_ssh_state (
      node_id, public_hostname, ssh_user, host_key_fingerprint,
      config_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(node_id) DO UPDATE SET
      public_hostname = excluded.public_hostname,
      ssh_user = excluded.ssh_user,
      host_key_fingerprint = excluded.host_key_fingerprint,
      config_updated_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).bind(nodeId, publicHostname, sshUser, fingerprint).run();
  return json({ ok: true, ssh: await nodeSshStateResponse(env, nodeId) });
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

async function ensureAiResponseArchiveStorage(env) {
  await ensurePayloadStorage(env);
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS ai_response_archives (
        query_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        payload_id TEXT NOT NULL UNIQUE,
        drive_file_id TEXT NOT NULL UNIQUE,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
        FOREIGN KEY (payload_id) REFERENCES payload_objects(payload_id) ON DELETE CASCADE
      )
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_ai_response_archives_node_created
      ON ai_response_archives(node_id, created_at DESC)
    `)
  ]);
}

export function aiResponseArchiveValue(nodeId, hostname, state, completedAt = new Date().toISOString()) {
  return {
    node_id: nodeId,
    hostname: hostname || nodeId,
    query_id: state.query_id,
    status: "completed",
    model: state.loaded_model || state.selected_model || null,
    mode: state.query_mode || null,
    prompt: state.query_prompt || "",
    response: state.query_answer,
    completed_at: completedAt
  };
}

async function archiveCompletedAiResponse(env, nodeId, state) {
  if (
    !state ||
    state.query_status !== "completed" ||
    typeof state.query_id !== "string" || !state.query_id ||
    typeof state.query_answer !== "string" || !state.query_answer
  ) return null;

  await ensureAiResponseArchiveStorage(env);
  const existing = await env.DB.prepare(
    "SELECT query_id, payload_id, drive_file_id, created_at FROM ai_response_archives WHERE query_id = ?"
  ).bind(state.query_id).first();
  if (existing) return existing;

  const node = await env.DB.prepare(
    "SELECT hostname FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();

  const payload = await persistDrivePayload(env, {
    owner_type: "ai_response",
    owner_id: state.query_id,
    kind: "ai_response",
    node_id: nodeId,
    value: aiResponseArchiveValue(nodeId, node?.hostname, state)
  });

  try {
    await env.DB.prepare(`
      INSERT INTO ai_response_archives (
        query_id, node_id, payload_id, drive_file_id, model
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      state.query_id,
      nodeId,
      payload.payload_id,
      payload.drive_file_id,
      state.loaded_model || state.selected_model || null
    ).run();
  } catch (error) {
    const duplicate = String(error).toLowerCase().includes("unique");
    await deletePayloadBestEffort(env, payload.payload_id);
    if (!duplicate) throw error;
  }

  return env.DB.prepare(
    "SELECT query_id, payload_id, drive_file_id, created_at FROM ai_response_archives WHERE query_id = ?"
  ).bind(state.query_id).first();
}

async function upsertNodeAiState(env, nodeId, state) {
  if (!state) return;
  await ensureNodeAiStorage(env);
  const stateJson = JSON.stringify(state);
  const saved = await env.DB.batch([
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
      WHERE node_ai_state.installed IS NOT excluded.installed
        OR node_ai_state.selected_model IS NOT COALESCE(excluded.selected_model, node_ai_state.selected_model)
        OR node_ai_state.loaded_model IS NOT excluded.loaded_model
        OR node_ai_state.server_running IS NOT excluded.server_running
        OR node_ai_state.last_action IS NOT COALESCE(excluded.last_action, node_ai_state.last_action)
        OR node_ai_state.updated_at <= datetime('now', '-5 minutes')
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
      WHERE node_ai_runtime_state.state_json IS NOT excluded.state_json
        OR node_ai_runtime_state.updated_at <= datetime('now', '-5 minutes')
        OR (json_extract(excluded.state_json, '$.operation_id') IS NOT NULL
          AND COALESCE(json_extract(excluded.state_json, '$.progress_phase'), '') NOT IN
            ('complete','completed','completed_partial','failed','cancelled','download_complete','load_complete','query_complete','ready')
          AND node_ai_runtime_state.updated_at <= datetime('now', '-60 seconds'))
    `).bind(nodeId, stateJson)
  ]);
  if (saved[1]?.meta?.changes) {
    await recordOperationalReport(env, nodeId, "lmstudio_state", state);
  }
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
      selected_model: null, loaded_model: null, observed: false
    };
  }
  const detail = safeJson(row.runtime_state_json, {});
  return {
    ...detail,
    observed: true,
    node_id: row.node_id,
    runtime: row.runtime,
    installed: row.installed,
    selected_model: row.selected_model,
    loaded_model: row.loaded_model,
    server_running: row.server_running,
    last_action: row.last_action,
    updated_at: parseControllerTimestamp(row.runtime_updated_at) > parseControllerTimestamp(row.updated_at)
      ? row.runtime_updated_at : row.updated_at,
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
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS agent_rollout_policy (
          rollout_id TEXT PRIMARY KEY,
          canary_node_id TEXT,
          phase TEXT NOT NULL DEFAULT 'canary'
            CHECK (phase IN ('canary','fleet','paused','completed')),
          max_parallel INTEGER NOT NULL DEFAULT 3 CHECK (max_parallel BETWEEN 1 AND 20),
          max_failures INTEGER NOT NULL DEFAULT 2 CHECK (max_failures BETWEEN 1 AND 20),
          pause_reason TEXT,
          canary_verified_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (rollout_id) REFERENCES agent_rollouts(rollout_id) ON DELETE CASCADE,
          FOREIGN KEY (canary_node_id) REFERENCES nodes(node_id) ON DELETE SET NULL
        )
      `)
    ]).catch((error) => {
      rolloutSchemaPromise = undefined;
      throw error;
    });
  }
  await rolloutSchemaPromise;
}

export function chooseSmartRolloutCanary(liveOutdated, previousPolicy) {
  const failedCanary = previousPolicy?.phase === "paused" &&
    String(previousPolicy.pause_reason || "").startsWith("canary_");
  if (!failedCanary) return liveOutdated[0] || null;
  // A deliberate retry should test a different live host instead of sending
  // the same release to the same failed canary again.
  return liveOutdated.find((node) => node.node_id !== previousPolicy.canary_node_id) || null;
}

async function startUpdateAllRollout(request, env) {
  const actor = await authenticateArchitect(request, env);
  await ensureRolloutStorage(env);
  const nodeRows = await env.DB.prepare(
    "SELECT node_id, hostname, agent_version, status, last_seen_at " +
    "FROM nodes WHERE status != 'revoked'"
  ).all();
  const registered = nodeRows.results || [];
  const productionNodes = registered.filter((node) => !isTestNodeRecord(node));
  const outdatedNodes = productionNodes.filter(
    (node) => node.agent_version !== LATEST_NODE_RELEASE.version
  );
  const updateableNow = outdatedNodes.filter(
    (node) => operationalNodeState(node) === "live"
  );
  const byFreshness = (left, right) =>
    parseControllerTimestamp(right.last_seen_at) - parseControllerTimestamp(left.last_seen_at);
  updateableNow.sort(byFreshness);
  outdatedNodes.sort(byFreshness);

  if (!outdatedNodes.length) {
    await env.DB.prepare(
      "UPDATE agent_rollouts SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE status = 'active'"
    ).run();
    return json({
      ok: true,
      rollout: {
        rollout_id: null,
        target_version: LATEST_NODE_RELEASE.version,
        status: "completed",
        phase: "completed",
        registered_nodes: productionNodes.length,
        nodes_waiting_for_update: 0,
        nodes_updateable_now: 0,
        nodes_deferred: 0,
        excluded_test_nodes: Math.max(0, registered.length - productionNodes.length),
        canary_node_id: null,
        canary_hostname: null,
        max_parallel: 3,
        max_failures: 2
      }
    });
  }

  // A lost HTTP response must not turn a second click into a new rollout.
  // A paused rollout is deliberately excluded: clicking again retries with
  // another canary after the operator has seen the pause reason.
  const activeRollout = await env.DB.prepare(
    "SELECT r.rollout_id, r.target_version, p.phase, p.canary_node_id, " +
    "n.hostname AS canary_hostname FROM agent_rollouts AS r " +
    "LEFT JOIN agent_rollout_policy AS p ON p.rollout_id = r.rollout_id " +
    "LEFT JOIN nodes AS n ON n.node_id = p.canary_node_id " +
    "WHERE r.status = 'active' LIMIT 1"
  ).first();
  if (activeRollout?.target_version === LATEST_NODE_RELEASE.version &&
      ["canary", "fleet"].includes(activeRollout.phase)) {
    return json({ ok: true, rollout: {
      rollout_id: activeRollout.rollout_id,
      target_version: activeRollout.target_version,
      status: "active",
      phase: activeRollout.phase,
      registered_nodes: productionNodes.length,
      nodes_waiting_for_update: outdatedNodes.length,
      nodes_updateable_now: updateableNow.length,
      nodes_deferred: Math.max(0, outdatedNodes.length - updateableNow.length),
      canary_node_id: activeRollout.canary_node_id,
      canary_hostname: activeRollout.canary_hostname || activeRollout.canary_node_id,
      max_parallel: 3,
      max_failures: 2,
      reused_existing: true
    } });
  }

  const previousPolicy = await env.DB.prepare(
    "SELECT p.canary_node_id, p.phase, p.pause_reason " +
    "FROM agent_rollout_policy AS p JOIN agent_rollouts AS r ON r.rollout_id = p.rollout_id " +
    "ORDER BY datetime(r.created_at) DESC, r.rowid DESC LIMIT 1"
  ).first();
  const canary = chooseSmartRolloutCanary(updateableNow, previousPolicy);
  if (!canary) throw new ApiError(409, updateableNow.length
    ? "rollout_no_live_alternative_canary" : "rollout_no_live_canary");
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
      "INSERT INTO agent_rollout_policy " +
      "(rollout_id, canary_node_id, phase, max_parallel, max_failures) " +
      "VALUES (?, ?, 'canary', 3, 2)"
    ).bind(rolloutId, canary.node_id),
    env.DB.prepare(
      "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
      "VALUES ('architect', ?, 'agent.rollout.started', 'rollout', ?, ?)"
    ).bind(actor.actor_id || "architect", rolloutId, JSON.stringify({
      target_version: LATEST_NODE_RELEASE.version,
      canary_node_id: canary.node_id,
      canary_hostname: canary.hostname || null,
      max_parallel: 3,
      max_failures: 2
    }))
  ]);

  return json({
    ok: true,
    rollout: {
      rollout_id: rolloutId,
      target_version: LATEST_NODE_RELEASE.version,
      status: "active",
      phase: "canary",
      registered_nodes: productionNodes.length,
      nodes_waiting_for_update: outdatedNodes.length,
      nodes_updateable_now: updateableNow.length,
      nodes_deferred: Math.max(0, outdatedNodes.length - updateableNow.length),
      excluded_test_nodes: Math.max(0, registered.length - productionNodes.length),
      canary_node_id: canary.node_id,
      canary_hostname: canary.hostname || canary.node_id,
      previous_failed_canary: previousPolicy?.phase === "paused" &&
        String(previousPolicy.pause_reason || "").startsWith("canary_")
        ? previousPolicy.canary_node_id : null,
      canary_live_now: operationalNodeState(canary) === "live",
      canary_timeout_seconds: 600,
      max_parallel: 3,
      max_failures: 2
    }
  }, 201);
}

function rolloutCommandAgeMs(command) {
  const raw = command?.completed_at || command?.created_at;
  const parsed = parseControllerTimestamp(raw);
  return parsed > 0 ? Math.max(0, Date.now() - parsed) : 0;
}

export function rolloutCommandOutcome(command, node, targetVersion, now = Date.now()) {
  if (!command) return "pending";
  const commandStarted = parseControllerTimestamp(command.created_at);
  const completed = parseControllerTimestamp(command.completed_at);
  const heartbeat = parseControllerTimestamp(node?.last_seen_at);
  if (commandStarted !== null && heartbeat !== null &&
      heartbeat > Math.max(commandStarted, completed || 0) &&
      node?.agent_version === targetVersion && operationalNodeState(node, now) === "live") {
    return "verified";
  }
  // The agent may install successfully and then fail while acknowledging the
  // command. A later live heartbeat with the target version is stronger proof.
  if (["failed", "cancelled", "expired"].includes(command.status)) return "failed";
  const age = completed || commandStarted;
  if (age !== null && now - age >=
      (command.status === "completed" ? 5 : 10) * 60 * 1000) return "failed";
  return "pending";
}

export function rolloutCommandRetryBlocked(command, node, targetVersion) {
  return rolloutCommandOutcome(command, node, targetVersion) === "failed" &&
    updatePayloadReadyForAgent(safeJson(command?.payload_json, {}), node?.agent_version);
}

async function smartRolloutAttempts(env, rollout) {
  // A superseded attempt is history, not another failed computer. Keep the
  // latest update per node, including the legacy bridge's intermediate hop.
  const rows = await env.DB.prepare(
    "SELECT c.node_id, c.command_id, c.status, c.created_at, c.completed_at, c.payload_json, " +
    "n.hostname, n.status AS node_status, n.agent_version, n.last_seen_at FROM commands c " +
    "JOIN nodes n ON n.node_id = c.node_id WHERE c.command_type = 'update' " +
    "AND n.status <> 'revoked' AND datetime(c.created_at) >= datetime(?) " +
    "AND NOT EXISTS (SELECT 1 FROM commands newer WHERE newer.node_id = c.node_id " +
    "AND newer.command_type = 'update' AND (datetime(newer.created_at) > datetime(c.created_at) " +
    "OR (datetime(newer.created_at) = datetime(c.created_at) AND newer.rowid > c.rowid)))"
  ).bind(rollout.created_at).all();
  return (rows.results || []).filter((row) => {
    const version = safeJson(row.payload_json, {})?.version;
    return !isTestNodeRecord(row) &&
      [rollout.target_version, LEGACY_031_BRIDGE_RELEASE.version].includes(version);
  });
}

export async function reconcileSmartRollout(env, rollout) {
  let failedNodes = [];
  let policy = await env.DB.prepare(
    "SELECT rollout_id, canary_node_id, phase, max_parallel, max_failures, pause_reason, canary_verified_at " +
    "FROM agent_rollout_policy WHERE rollout_id = ?"
  ).bind(rollout.rollout_id).first();
  // An active rollout created before smart gating is deliberately frozen instead
  // of being allowed to fan out blindly. Starting Update All again creates a
  // fresh canary-gated rollout.
  if (!policy) {
    return {
      rollout_id: rollout.rollout_id,
      canary_node_id: null,
      phase: "paused",
      max_parallel: 1,
      max_failures: 1,
      pause_reason: "legacy_rollout_requires_restart",
      canary_verified_at: null
    };
  }

  const canaryPaused = policy.phase === "paused" &&
    String(policy.pause_reason || "").startsWith("canary_");
  const fleetPaused = policy.phase === "paused" &&
    policy.pause_reason === "fleet_failure_budget_exceeded" &&
    Boolean(policy.canary_verified_at);
  if (policy.phase === "canary" || canaryPaused) {
    const [canary, command] = await Promise.all([
      env.DB.prepare(
        "SELECT node_id, hostname, status, agent_version, last_seen_at FROM nodes WHERE node_id = ?"
      ).bind(policy.canary_node_id).first(),
      env.DB.prepare(
        "SELECT command_id, status, created_at, completed_at, payload_json FROM commands " +
        "WHERE node_id = ? AND command_type = 'update' " +
        "AND datetime(created_at) >= datetime(?) ORDER BY created_at DESC LIMIT 1"
      ).bind(policy.canary_node_id, rollout.created_at).first()
    ]);

    if (
      rolloutCommandOutcome(command, canary, rollout.target_version) === "verified"
    ) {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE agent_rollout_policy SET phase = 'fleet', canary_verified_at = CURRENT_TIMESTAMP, " +
          "pause_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE rollout_id = ?"
        ).bind(rollout.rollout_id),
        env.DB.prepare(
          "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
          "VALUES ('controller', ?, 'agent.rollout.canary_verified', 'rollout', ?, ?)"
        ).bind(rollout.rollout_id, rollout.rollout_id, JSON.stringify({
          node_id: canary.node_id,
          target_version: rollout.target_version
        }))
      ]);
    } else if (policy.phase === "canary" && command) {
      let pauseReason = null;
      if (["failed","cancelled","expired"].includes(command.status)) {
        pauseReason = "canary_command_" + command.status;
      } else if (
        command.status === "completed" &&
        rolloutCommandAgeMs(command) >= 5 * 60 * 1000
      ) {
        pauseReason = "canary_heartbeat_timeout";
      } else if (
        ["pending","accepted"].includes(command.status) &&
        rolloutCommandAgeMs(command) >= 10 * 60 * 1000
      ) {
        pauseReason = "canary_update_timeout";
      }
      if (pauseReason) {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE agent_rollout_policy SET phase = 'paused', pause_reason = ?, " +
            "updated_at = CURRENT_TIMESTAMP WHERE rollout_id = ?"
          ).bind(pauseReason, rollout.rollout_id),
          env.DB.prepare(
            "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
            "VALUES ('controller', ?, 'agent.rollout.paused', 'rollout', ?, ?)"
          ).bind(rollout.rollout_id, rollout.rollout_id, JSON.stringify({
            reason: pauseReason,
            node_id: policy.canary_node_id,
            target_version: rollout.target_version
          }))
        ]);
      }
    }
  } else if (policy.phase === "fleet" || fleetPaused) {
    const attempts = await smartRolloutAttempts(env, rollout);
    const outcomes = attempts.map((row) =>
      rolloutCommandOutcome(row, { ...row, status: row.node_status }, rollout.target_version));
    failedNodes = attempts.filter((row, i) => outcomes[i] === "failed").map((row) => ({
      node_id: row.node_id, hostname: row.hostname || row.node_id,
      command_id: row.command_id, command_status: row.status,
      agent_version: row.agent_version || null
    }));
    const failures = outcomes.filter((outcome) => outcome === "failed").length;
    if (failures >= Number(policy.max_failures || 2)) {
      const reason = "fleet_failure_budget_exceeded";
      if (!fleetPaused) {
        await env.DB.prepare(
          "UPDATE agent_rollout_policy SET phase = 'paused', pause_reason = ?, " +
          "updated_at = CURRENT_TIMESTAMP WHERE rollout_id = ?"
        ).bind(reason, rollout.rollout_id).run();
      }
    } else if (fleetPaused && outcomes.includes("verified")) {
      // Fresh target-version evidence is required to recover the pause. The
      // same failure budget and parallelism limits still apply after recovery.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE agent_rollout_policy SET phase = 'fleet', pause_reason = NULL, " +
          "updated_at = CURRENT_TIMESTAMP WHERE rollout_id = ? AND phase = 'paused' " +
          "AND pause_reason = 'fleet_failure_budget_exceeded'"
        ).bind(rollout.rollout_id),
        env.DB.prepare(
          "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
          "VALUES ('controller', ?, 'agent.rollout.fleet_recovered', 'rollout', ?, ?)"
        ).bind(rollout.rollout_id, rollout.rollout_id, JSON.stringify({
          target_version: rollout.target_version, failed_nodes: failures
        }))
      ]);
    }
  }

  policy = await env.DB.prepare(
    "SELECT rollout_id, canary_node_id, phase, max_parallel, max_failures, pause_reason, canary_verified_at " +
    "FROM agent_rollout_policy WHERE rollout_id = ?"
  ).bind(rollout.rollout_id).first();
  return policy ? { ...policy, failed_node_count: failedNodes.length, failed_nodes: failedNodes.slice(0, 20) } : policy;
}

async function architectUpdateRolloutStatus(request, env) {
  await authenticateArchitect(request, env);
  await ensureRolloutStorage(env);
  const rollout = await env.DB.prepare(
    "SELECT rollout_id, target_version, release_json, status, created_at, updated_at " +
    "FROM agent_rollouts ORDER BY created_at DESC LIMIT 1"
  ).first();
  if (!rollout) return json({ ok: true, rollout: null });
  const policy = rollout.status === "active"
    ? await reconcileSmartRollout(env, rollout)
    : await env.DB.prepare(
        "SELECT rollout_id, canary_node_id, phase, max_parallel, max_failures, pause_reason, canary_verified_at " +
        "FROM agent_rollout_policy WHERE rollout_id = ?"
      ).bind(rollout.rollout_id).first();
  const nodeRows = await env.DB.prepare(
    "SELECT node_id, hostname, agent_version, status, last_seen_at FROM nodes WHERE status != 'revoked'"
  ).all();
  const production = (nodeRows.results || []).filter((node) => !isTestNodeRecord(node));
  const outdated = production.filter((node) => node.agent_version !== rollout.target_version);
  const liveOutdated = outdated.filter((node) => operationalNodeState(node) === "live");
  const canary = policy?.canary_node_id
    ? production.find((node) => node.node_id === policy.canary_node_id) || null
    : null;
  const canaryNeedsLogs = policy?.phase === "paused" &&
    String(policy.pause_reason || "").startsWith("canary_");
  const canaryCommand = canaryNeedsLogs
    ? await env.DB.prepare(
        "SELECT command_id, status FROM commands WHERE node_id = ? " +
        "AND command_type = 'update' AND datetime(created_at) >= datetime(?) " +
        "ORDER BY datetime(created_at) DESC, command_id DESC LIMIT 1"
      ).bind(policy.canary_node_id, rollout.created_at).first()
    : null;
  return json({
    ok: true,
    rollout: {
      rollout_id: rollout.rollout_id,
      target_version: rollout.target_version,
      status: rollout.status,
      phase: policy?.phase || null,
      pause_reason: policy?.pause_reason || null,
      failed_node_count: Number(policy?.failed_node_count || 0),
      failed_nodes: policy?.failed_nodes || [],
      max_parallel: Number(policy?.max_parallel || 0),
      max_failures: Number(policy?.max_failures || 0),
      canary_verified_at: policy?.canary_verified_at || null,
      canary_node_id: policy?.canary_node_id || null,
      canary_hostname: canary?.hostname || null,
      canary_agent_version: canary?.agent_version || null,
      canary_live: canary ? operationalNodeState(canary) === "live" : false,
      canary_command_id: canaryCommand?.command_id || null,
      canary_command_status: canaryCommand?.status || null,
      canary_diagnostic_hint: canaryNeedsLogs ? "agent_logs_required" : null,
      registered_nodes: production.length,
      nodes_waiting_for_update: outdated.length,
      nodes_updateable_now: liveOutdated.length,
      nodes_deferred: Math.max(0, outdated.length - liveOutdated.length)
    }
  });
}

async function ensureRolloutCommandForNode(env, nodeId) {
  await Promise.all([ensureRolloutStorage(env), ensureCommandStorage(env)]);
  // Rollouts are exceptional. On the steady-state polling path, do one indexed
  // lookup and return before touching node/command history.
  let rollout = await env.DB.prepare(
    "SELECT rollout_id, target_version, release_json, created_at FROM agent_rollouts WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).first();
  if (!rollout) return;
  rollout = await recoverPatchedRollout(env, rollout, LATEST_NODE_RELEASE, nodeId,
    (candidate, policy) => operationalNodeState(candidate) === 'live' &&
      Boolean(chooseSmartRolloutCanary([candidate], policy)), Date.now(), expireStaleCommands);
  const rolloutPolicy = await reconcileSmartRollout(env, rollout);
  if (!rolloutPolicy || ["paused","completed"].includes(rolloutPolicy.phase)) return;
  if (rolloutPolicy.phase === "canary" && nodeId !== rolloutPolicy.canary_node_id) return;
  if (rolloutPolicy.phase === "fleet") {
    const attempts = await smartRolloutAttempts(env, rollout);
    const unverified = attempts.filter((row) =>
      rolloutCommandOutcome(row, { ...row, status: row.node_status }, rollout.target_version) === "pending").length;
    if (unverified >= Number(rolloutPolicy.max_parallel || 3)) return;
  }

  // Stale active commands only need cleanup when a rollout actually needs the
  // single-active-command slot. Normal agent polling must not scan for stale
  // commands every 30 seconds.
  await expireStaleNodeCommands(env, nodeId);
  const [node, pending, recentCompletedUpdate, latestUpdate] = await Promise.all([
    env.DB.prepare(
      "SELECT node_id, hostname, status, agent_version, last_seen_at FROM nodes WHERE node_id = ?"
    ).bind(nodeId).first(),
    env.DB.prepare(
      "SELECT command_id, command_type, status, payload_json FROM commands " +
      "WHERE node_id = ? AND status IN ('pending', 'accepted') LIMIT 1"
    ).bind(nodeId).first(),
    env.DB.prepare(
      "SELECT payload_json, completed_at FROM commands " +
      "WHERE node_id = ? AND command_type = 'update' AND status = 'completed' " +
      "AND datetime(completed_at) >= datetime('now', '-10 minutes') " +
      "ORDER BY completed_at DESC LIMIT 1"
    ).bind(nodeId).first(),
    env.DB.prepare(
      "SELECT status, payload_json, created_at, completed_at FROM commands " +
      "WHERE node_id = ? AND command_type = 'update' " +
      "AND datetime(created_at) >= datetime(?) " +
      "ORDER BY datetime(created_at) DESC, rowid DESC LIMIT 1"
    ).bind(nodeId, rollout.created_at).first()
  ]);
  if (
    !node ||
    node.status === "revoked" ||
    isTestNodeRecord(node) ||
    rollout.target_version !== LATEST_NODE_RELEASE.version ||
    node.agent_version === rollout.target_version
  ) {
    return;
  }
  // Counting computers rather than old attempts must not create endless
  // retries on one broken computer. Retry only a revised pinned payload or a
  // new operator-started rollout after an unconfirmed/failed installation.
  if (rolloutCommandRetryBlocked(latestUpdate, node, rollout.target_version)) return;
  if (pending) {
    if (pending.command_type !== "update" || pending.status !== "pending" ||
        updatePayloadReadyForAgent(safeJson(pending.payload_json, {}), node.agent_version)) return;
    const retired = await env.DB.prepare(
      "UPDATE commands SET status = 'failed', completed_at = CURRENT_TIMESTAMP " +
      "WHERE command_id = ? AND status = 'pending'"
    ).bind(pending.command_id).run();
    if (Number(retired?.meta?.changes || 0) !== 1) return;
    await env.DB.prepare(
      "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
      "VALUES ('controller', ?, 'agent.rollout.incompatible_command_retired', 'command', ?, ?)"
    ).bind(rollout.rollout_id, pending.command_id, JSON.stringify({
      node_id: nodeId, agent_version: node.agent_version
    })).run();
  }
  const recentlyInstalled = recentCompletedUpdate
    ? safeJson(recentCompletedUpdate.payload_json, {})?.version === rollout.target_version
    : false;
  if (recentlyInstalled) return;
  const commandId = "command_" + crypto.randomUUID();
  const payloadJson = JSON.stringify(releaseForAgentVersion(
    LATEST_NODE_RELEASE, node.agent_version
  ));
  const createdAt = new Date().toISOString();
  const signature = await signControllerCommand(
    env, commandId, nodeId, "update", payloadJson, createdAt
  );
  try {
    const insert = rolloutPolicy.phase === "fleet"
      ? env.DB.prepare(
        "INSERT INTO commands (command_id, node_id, command_type, payload_json, signature, status, created_at) " +
        "SELECT ?, ?, 'update', ?, ?, 'pending', ? WHERE (" +
        "SELECT COUNT(*) FROM commands c JOIN nodes n ON n.node_id = c.node_id " +
        "WHERE c.command_type = 'update' AND datetime(c.created_at) >= datetime(?) " +
        "AND NOT EXISTS (SELECT 1 FROM commands newer WHERE newer.node_id = c.node_id " +
        "AND newer.command_type = 'update' AND (datetime(newer.created_at) > datetime(c.created_at) " +
        "OR (datetime(newer.created_at) = datetime(c.created_at) AND newer.rowid > c.rowid))) " +
        "AND ((c.status IN ('pending','accepted') AND datetime(c.created_at) > datetime('now','-10 minutes')) " +
        "OR (c.status = 'completed' AND datetime(COALESCE(c.completed_at,c.created_at)) > datetime('now','-5 minutes'))) " +
        "AND (n.agent_version IS NULL OR n.agent_version <> ? OR n.status <> 'online' " +
        "OR n.last_seen_at IS NULL " +
        "OR datetime(n.last_seen_at) <= datetime(COALESCE(c.completed_at,c.created_at)) " +
        "OR datetime(n.last_seen_at) < datetime('now','-5 minutes'))) < ?"
      ).bind(commandId, nodeId, payloadJson, signature, createdAt,
        rollout.created_at, rollout.target_version, Number(rolloutPolicy.max_parallel || 3))
      : env.DB.prepare(
        "INSERT INTO commands (command_id, node_id, command_type, payload_json, signature, status, created_at) " +
        "VALUES (?, ?, 'update', ?, ?, 'pending', ?)"
      ).bind(commandId, nodeId, payloadJson, signature, createdAt);
    const inserted = await insert.run();
    if (Number(inserted?.meta?.changes || 0) !== 1) return;
    await env.DB.prepare(
      "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
      "VALUES ('controller', ?, 'agent.rollout.command_created', 'command', ?, ?)"
    ).bind(rollout.rollout_id, commandId, JSON.stringify({ node_id: nodeId, target_version: rollout.target_version })).run();
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
  }
}

async function repairPendingUpdateForNode(env, node) {
  const pending = await env.DB.prepare(
    "SELECT command_id, payload_json FROM commands " +
    "WHERE node_id = ? AND command_type = 'update' AND status = 'pending' LIMIT 1"
  ).bind(node.node_id).first();
  if (!pending || updatePayloadReadyForAgent(
    safeJson(pending.payload_json, {}), node.agent_version
  )) return;

  const commandId = "command_" + crypto.randomUUID();
  const payloadJson = JSON.stringify(releaseForAgentVersion(
    LATEST_NODE_RELEASE, node.agent_version
  ));
  const createdAt = new Date().toISOString();
  const signature = await signControllerCommand(
    env, commandId, node.node_id, "update", payloadJson, createdAt
  );
  const retired = await env.DB.prepare(
    "UPDATE commands SET status = 'failed', completed_at = CURRENT_TIMESTAMP " +
    "WHERE command_id = ? AND status = 'pending'"
  ).bind(pending.command_id).run();
  if (Number(retired?.meta?.changes || 0) !== 1) return;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO commands (command_id, node_id, command_type, payload_json, signature, status, created_at) " +
        "VALUES (?, ?, 'update', ?, ?, 'pending', ?)"
      ).bind(commandId, node.node_id, payloadJson, signature, createdAt),
      env.DB.prepare(
        "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
        "VALUES ('controller', 'controller', 'agent.update.incompatible_command_replaced', 'command', ?, ?)"
      ).bind(pending.command_id, JSON.stringify({
        node_id: node.node_id, agent_version: node.agent_version, replacement_command_id: commandId
      }))
    ]);
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
  }
}

async function continueCompletedBridgeUpdateForNode(env, node) {
  if (node.agent_version !== LEGACY_031_BRIDGE_RELEASE.version) return;

  // Only continue an update that the operator (or rollout) already started.
  // Looking at the latest update command avoids turning ordinary old nodes into
  // unsolicited auto-updates and prevents retry loops after a failed final hop.
  const latestUpdate = await env.DB.prepare(
    "SELECT command_id, status, payload_json, created_at, completed_at FROM commands " +
    "WHERE node_id = ? AND command_type = 'update' " +
    "ORDER BY datetime(created_at) DESC LIMIT 1"
  ).bind(node.node_id).first();
  if (
    !latestUpdate ||
    latestUpdate.status !== "completed" ||
    safeJson(latestUpdate.payload_json, {})?.version !== LEGACY_031_BRIDGE_RELEASE.version
  ) {
    return;
  }

  const payload = releaseForAgentVersion(LATEST_NODE_RELEASE, node.agent_version);
  if (
    payload.version !== LATEST_NODE_RELEASE.version ||
    !updatePayloadReadyForAgent(payload, node.agent_version)
  ) {
    return;
  }

  const commandId = "command_" + crypto.randomUUID();
  const payloadJson = JSON.stringify(payload);
  const createdAt = new Date().toISOString();
  const signature = await signControllerCommand(
    env, commandId, node.node_id, "update", payloadJson, createdAt
  );
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO commands (command_id, node_id, command_type, payload_json, signature, status, created_at) " +
        "VALUES (?, ?, 'update', ?, ?, 'pending', ?)"
      ).bind(commandId, node.node_id, payloadJson, signature, createdAt),
      env.DB.prepare(
        "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
        "VALUES ('controller', 'controller', 'agent.update.bridge_continued', 'command', ?, ?)"
      ).bind(commandId, JSON.stringify({
        node_id: node.node_id,
        bridge_command_id: latestUpdate.command_id,
        bridge_version: LEGACY_031_BRIDGE_RELEASE.version,
        target_version: LATEST_NODE_RELEASE.version
      }))
    ]);
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
  }
}


export function failedBridgeUpdateNeedsNewRelease(latest, agentVersion, release) {
  if (agentVersion !== LEGACY_031_BRIDGE_RELEASE.version ||
      latest?.status !== "failed") return false;
  const previous = safeJson(latest.payload_json, {});
  const current = releaseForAgentVersion(release, agentVersion);
  return previous.version === current.version &&
    updatePayloadCompatibleWithAgent(previous, agentVersion) &&
    !updatePayloadReadyForAgent(previous, agentVersion) &&
    previous.files.some((file) => current.files.some((candidate) =>
      candidate.path === file.path && candidate.sha256 !== file.sha256));
}

async function retryFailedBridgeUpdateForNode(env, node) {
  if (node.agent_version !== LEGACY_031_BRIDGE_RELEASE.version) return;
  const latest = await env.DB.prepare(
    "SELECT command_id, status, payload_json FROM commands " +
    "WHERE node_id = ? AND command_type = 'update' " +
    "ORDER BY datetime(created_at) DESC, rowid DESC LIMIT 1"
  ).bind(node.node_id).first();
  if (!failedBridgeUpdateNeedsNewRelease(latest, node.agent_version, LATEST_NODE_RELEASE)) return;

  // Stale active commands still occupy the per-node unique command slot.
  // Reclaim only for a genuinely changed, signed bridge retry (not each poll).
  await expireStaleNodeCommands(env, node.node_id);

  // One retry per changed, hash-pinned release. A second failure with the new
  // payload becomes the latest command and will not pass the predicate again.
  const payload = releaseForAgentVersion(LATEST_NODE_RELEASE, node.agent_version);
  const commandId = "command_" + crypto.randomUUID();
  const payloadJson = JSON.stringify(payload);
  const createdAt = new Date().toISOString();
  const signature = await signControllerCommand(
    env, commandId, node.node_id, "update", payloadJson, createdAt
  );
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO commands (command_id, node_id, command_type, payload_json, signature, status, created_at) " +
        "VALUES (?, ?, 'update', ?, ?, 'pending', ?)"
      ).bind(commandId, node.node_id, payloadJson, signature, createdAt),
      env.DB.prepare(
        "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
        "VALUES ('controller', 'controller', 'agent.update.failed_bridge_retried', 'command', ?, ?)"
      ).bind(commandId, JSON.stringify({
        node_id: node.node_id, failed_command_id: latest.command_id,
        target_version: payload.version
      }))
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
  { id: "security_analyst", label: "Security Analyst", kind: "worker", origin: "architect_extension_2026_09_18" },
  { id: "engineer", label: "Engineer", kind: "worker", origin: "ee_professions_2026_09" },
  { id: "scientist", label: "Scientist", kind: "worker", origin: "ee_professions_2026_09" }
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

function normalizeProjectWorkerTarget(value) {
  if (value === undefined || value === null || value === "" || value === "auto") return { mode: "auto", count: null };
  if (value === "all") return { mode: "all", count: null };
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new ApiError(400, "invalid_worker_target");
  return { mode: "fixed", count };
}

function schedulingFromChecks(checksJson) {
  const checks = typeof checksJson === "string" ? safeJson(checksJson, {}) : (checksJson || {});
  const scheduling = checks?.scheduling;
  const mode = ["auto", "fixed", "all"].includes(scheduling?.target_mode) ? scheduling.target_mode : "auto";
  const desired = Number(scheduling?.desired_workers);
  return {
    target_mode: mode,
    desired_workers: Number.isInteger(desired) && desired >= 1 && desired <= 50 ? desired : null
  };
}

function targetProjectWork(taskText, requestedRoles, executionMode, desiredWorkers) {
  const sourceText = String(taskText || "").trim();
  const explicitRoles = Array.isArray(requestedRoles) && requestedRoles.length
    ? requestedRoles
    : [];
  let items = executionMode === "python"
    ? (explicitRoles.length
        ? explicitRoles.map((roleName, index) => ({
            sequence_no: index + 1,
            role_name: roleName,
            task_text: sourceText,
            role_source: "architect_added"
          }))
        : [{ sequence_no: 1, role_name: "programmer", task_text: sourceText, role_source: "hub_recommended" }])
    : planProjectWork(sourceText, requestedRoles);
  if (!Number.isInteger(desiredWorkers)) return items;
  const target = Math.max(1, Math.min(50, desiredWorkers));
  if (items.length > target) items = items.slice(0, target);
  const roles = items.map((item) => item.role_name).filter(Boolean);
  const fallbackRoles = roles.length ? roles : (executionMode === "python" ? ["programmer"] : ["planner"]);
  while (items.length < target) {
    const slot = items.length;
    const roleName = fallbackRoles[slot % fallbackRoles.length];
    const task = executionMode === "python"
      ? sourceText
      : "Act as an independent CITADEL worker in a multi-host run. Analyze the original task from your assigned role, avoid generic duplication, and return evidence, reasoning, edge cases or a concrete solution that improves the final synthesis.\n\nWorker " + (slot + 1) + " of " + target + " · role: " + roleName + "\n\nOriginal task:\n" + sourceText;
    items.push({ sequence_no: slot + 1, role_name: roleName, task_text: task, role_source: "hub_recommended" });
  }
  return items.map((item, index) => ({ ...item, sequence_no: index + 1 }));
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
    ["engineer", /(engineer|engineering|architecture|infrastructure|system design|hardware|network design|инженер|архитектур|инфраструктур|системн.*проект)/],
    ["scientist", /(scientist|science|scientific|hypothesis|experiment|physics|chemistry|biology|уч[её]н|научн|гипотез|эксперимент|физик|хими|биолог)/],
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
        CREATE INDEX IF NOT EXISTS idx_architect_projects_created
        ON architect_projects(created_at DESC)
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
        CREATE INDEX IF NOT EXISTS idx_project_work_items_status_project_created
        ON project_work_items(status, project_id, created_at, sequence_no)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_nodes_status_last_seen
        ON nodes(status, last_seen_at DESC, node_id)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_audit_events_created_action
        ON audit_events(created_at DESC, action)
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
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS project_assignment_recovery_gate (
          gate_id INTEGER PRIMARY KEY CHECK (gate_id = 1),
          next_run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      env.DB.prepare(`
        INSERT OR IGNORE INTO project_assignment_recovery_gate (gate_id, next_run_at)
        VALUES (1, CURRENT_TIMESTAMP)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_assignments_status_assigned_at
        ON assignments(status, assigned_at)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_assignments_status_started_at
        ON assignments(status, started_at)
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

async function qualityGateResultFromRow(env, row, rawText) {
  if (!row) return null;
  if (row.status === "completed" && typeof row.final_text === "string" && row.final_text.trim()) {
    const content = drivePointerId(row.final_text)
      ? await resolveDriveText(env, row.final_text)
      : row.final_text;
    return {
      ready: true,
      status: "completed",
      content,
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


async function projectQualityGateSnapshot(env, projectId, originalTask, rawText) {
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
  const row = await env.DB.prepare(`
    SELECT project_id, source_sha256, status, requested_model, resolved_model,
      fusion_preset, final_text, error_code, claim_id, updated_at
    FROM project_quality_gates
    WHERE project_id = ?
  `).bind(projectId).first();

  if (row?.source_sha256 === sourceSha256) {
    const cached = await qualityGateResultFromRow(env, row, draft);
    if (cached) return cached;
  }
  return {
    ready: true,
    status: "deferred",
    content: draft,
    reviewed: false,
    model: config.model,
    error_code: null
  };
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
    const cached = await qualityGateResultFromRow(env, current, draft);
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
  const supersededQualityPayloadId = current?.source_sha256 !== sourceSha256
    ? drivePointerId(current?.final_text)
    : null;

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

    if ((claim?.meta?.changes || 0) === 1 && supersededQualityPayloadId) {
      await deletePayloadBestEffort(env, supersededQualityPayloadId);
    }
    if ((claim?.meta?.changes || 0) === 0) {
      const row = await env.DB.prepare(`
        SELECT project_id, source_sha256, status, requested_model, resolved_model,
          fusion_preset, final_text, error_code, claim_id, updated_at
        FROM project_quality_gates WHERE project_id = ?
      `).bind(projectId).first();
      return await qualityGateResultFromRow(env, row, draft) || {
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
    const qualityPayload = await persistDrivePayload(env, {
      owner_type: "project",
      owner_id: projectId,
      kind: "quality_final",
      value: { text: reviewed.content, model: reviewed.model }
    });
    const qualityPointer = drivePointer(qualityPayload.payload_id);
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
    `).bind(reviewed.model, qualityPointer, projectId, sourceSha256, claimId).run();

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

    await deletePayloadBestEffort(env, qualityPayload.payload_id);
    const row = await env.DB.prepare(`
      SELECT project_id, source_sha256, status, requested_model, resolved_model,
        fusion_preset, final_text, error_code, claim_id, updated_at
      FROM project_quality_gates WHERE project_id = ?
    `).bind(projectId).first();
    return await qualityGateResultFromRow(env, row, draft) || {
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
  const maxSectionChars = 12000;
  const maxCombinedChars = 180000;
  const parts = [];
  let used = 0;
  for (const item of sections || []) {
    if (typeof item?.content !== "string" || !item.content.trim()) continue;
    const header = `#${item.sequence_no} ${item.role_name}\n`;
    let body = item.content.trim();
    if (body.length > maxSectionChars) body = body.slice(0, maxSectionChars) + "\n[worker output truncated]";
    const remaining = maxCombinedChars - used - header.length - (parts.length ? 2 : 0);
    if (remaining <= 0) break;
    if (body.length > remaining) body = body.slice(0, Math.max(0, remaining)) + "\n[combined output truncated]";
    const part = header + body;
    parts.push(part);
    used += part.length + (parts.length > 1 ? 2 : 0);
    if (used >= maxCombinedChars) break;
  }
  return parts.join("\n\n");
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

export async function recoverStaleProjectAssignments(env) {
  const maxRows = arguments.length > 1 ? arguments[1] : 150;
  await ensureProjectStorage(env);

  const active = await env.DB.prepare(
    "SELECT work_item_id FROM project_work_items WHERE status IN ('assigned','running') LIMIT 1"
  ).first();
  if (!active) return 0;

  const gate = await env.DB.prepare(`
    UPDATE project_assignment_recovery_gate
    SET next_run_at = datetime('now', '+60 seconds')
    WHERE gate_id = 1
      AND next_run_at <= CURRENT_TIMESTAMP
  `).run();
  if ((gate?.meta?.changes || 0) !== 1) return 0;

  const nodeLivenessCutoffIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const nodeLivenessCutoffSqlite = nodeLivenessCutoffIso
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
  const livenessClause = `
        AND (
          n.node_id IS NULL
          OR n.status != 'online'
          OR (instr(n.last_seen_at, 'T') > 0 AND n.last_seen_at < ?)
          OR (instr(n.last_seen_at, 'T') = 0 AND n.last_seen_at < ?)
        )`;
  const scans = await env.DB.batch([
    env.DB.prepare(`
      SELECT a.assignment_id, a.node_id, a.status AS assignment_status,
        a.assigned_at, a.started_at, w.work_item_id, w.project_id,
        w.status AS work_status
      FROM assignments AS a
      JOIN project_work_items AS w
        ON a.assignment_id = ('assignment_' || w.work_item_id)
      WHERE a.status = 'assigned'
        AND a.assigned_at <= datetime('now', '-10 minutes')
        AND w.status IN ('assigned','running')
        AND NOT EXISTS (
          SELECT 1 FROM results AS r WHERE r.assignment_id = a.assignment_id
        )
      ORDER BY a.assigned_at ASC
      LIMIT 50
    `),
    env.DB.prepare(`
      SELECT a.assignment_id, a.node_id, a.status AS assignment_status,
        a.assigned_at, a.started_at, w.work_item_id, w.project_id,
        w.status AS work_status
      FROM assignments AS a
      JOIN project_work_items AS w
        ON a.assignment_id = ('assignment_' || w.work_item_id)
      LEFT JOIN nodes AS n ON n.node_id = a.node_id
      WHERE a.status = 'running'
        AND a.started_at IS NOT NULL
        AND a.started_at <= datetime('now', '-45 minutes')
        AND w.status IN ('assigned','running')
        AND NOT EXISTS (
          SELECT 1 FROM results AS r WHERE r.assignment_id = a.assignment_id
        )
        ${livenessClause}
      ORDER BY a.started_at ASC
      LIMIT 50
    `).bind(nodeLivenessCutoffIso, nodeLivenessCutoffSqlite),
    env.DB.prepare(`
      SELECT a.assignment_id, a.node_id, a.status AS assignment_status,
        a.assigned_at, a.started_at, w.work_item_id, w.project_id,
        w.status AS work_status
      FROM assignments AS a
      JOIN project_work_items AS w
        ON a.assignment_id = ('assignment_' || w.work_item_id)
      LEFT JOIN nodes AS n ON n.node_id = a.node_id
      WHERE a.status = 'running'
        AND a.started_at IS NULL
        AND a.assigned_at <= datetime('now', '-45 minutes')
        AND w.status IN ('assigned','running')
        AND NOT EXISTS (
          SELECT 1 FROM results AS r WHERE r.assignment_id = a.assignment_id
        )
        ${livenessClause}
      ORDER BY a.assigned_at ASC
      LIMIT 50
    `).bind(nodeLivenessCutoffIso, nodeLivenessCutoffSqlite)
  ]);

  const recoveryLimit = Math.max(1, Math.min(150, Number(maxRows) || 150));
  const stale = [
    ...(scans[0]?.results || []),
    ...(scans[1]?.results || []),
    ...(scans[2]?.results || [])
  ].slice(0, recoveryLimit);
  let recovered = 0;
  for (const row of stale) {
    const reason = row.assignment_status === "running"
      ? "running_node_heartbeat_lost"
      : "assigned_accept_lease_expired";
    const detailsJson = JSON.stringify({
      project_id: row.project_id,
      previous_node_id: row.node_id,
      previous_assignment_status: row.assignment_status,
      previous_work_status: row.work_status,
      reason
    });
    const requeue = await env.DB.batch([
      env.DB.prepare(`
        UPDATE assignments
        SET status = 'failed', completed_at = CURRENT_TIMESTAMP
        WHERE assignment_id = ?
          AND node_id = ?
          AND status = ?
          AND NOT EXISTS (
            SELECT 1 FROM results WHERE results.assignment_id = assignments.assignment_id
          )
      `).bind(row.assignment_id, row.node_id, row.assignment_status),
      env.DB.prepare(`
        UPDATE project_work_items
        SET node_id = NULL, status = 'planned', updated_at = CURRENT_TIMESTAMP
        WHERE work_item_id = ?
          AND project_id = ?
          AND node_id = ?
          AND status = ?
          AND EXISTS (
            SELECT 1 FROM assignments
            WHERE assignment_id = ?
              AND node_id = ?
              AND status = 'failed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM results WHERE assignment_id = ?
          )
      `).bind(
        row.work_item_id, row.project_id, row.node_id, row.work_status,
        row.assignment_id, row.node_id, row.assignment_id
      ),
      env.DB.prepare(`
        INSERT INTO audit_events (
          actor_type, actor_id, action, target_type, target_id, details_json
        )
        SELECT 'controller', 'assignment-reaper', 'project.work.requeued_stale',
          'project_work_item', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM project_work_items
          WHERE work_item_id = ?
            AND project_id = ?
            AND status = 'planned'
            AND node_id IS NULL
        )
      `).bind(row.work_item_id, detailsJson, row.work_item_id, row.project_id)
    ]);
    if ((requeue[1]?.meta?.changes || 0) === 1) recovered += 1;
  }
  return recovered;
}

function projectExecutionMode(sourceType) {
  return sourceType === "architect_python" ? "python" : "ai";
}

function projectNodeReady(node, sourceType) {
  if (!node || operationalNodeState({ ...node, status: node.status || "online" }) !== "live" || isTestNodeRecord(node)) {
    return false;
  }
  const capabilities = safeJson(node.capabilities_json, []);
  if (!Array.isArray(capabilities)) return false;
  if (projectExecutionMode(sourceType) === "python") {
    return capabilities.includes("project_python");
  }
  return capabilities.includes("project_text") &&
    Number(node.installed || node.lmstudio_installed || 0) === 1 &&
    Number(node.server_running || node.lmstudio_server_running || 0) === 1 &&
    typeof (node.loaded_model || node.lmstudio_loaded_model) === "string" &&
    (node.loaded_model || node.lmstudio_loaded_model).length > 0 &&
    Number(node.inference_ready || 0) === 1;
}

/**
 * Materialize compatible planned project work for one live node.
 * Compatibility is applied before the scan limit so mixed AI/Python queues cannot starve later work.
 */
async function materializeProjectWorkForNode(env, nodeId, projectId = null) {
  await Promise.all([ensureProjectStorage(env), ensureNodeAiStorage(env), ensurePayloadStorage(env)]);
  // Most assignment polls happen with no queued project work. Use the
  // status-first index to prove that cheaply before loading node AI state and
  // the fleet-wide readiness set.
  const plannedWork = projectId
    ? await env.DB.prepare(
        "SELECT work_item_id FROM project_work_items WHERE status = 'planned' AND project_id = ? LIMIT 1"
      ).bind(projectId).first()
    : await env.DB.prepare(
        "SELECT work_item_id FROM project_work_items WHERE status = 'planned' LIMIT 1"
      ).first();
  if (!plannedWork) return 0;

  const node = await env.DB.prepare(`
    SELECT n.node_id, n.hostname, n.status, n.last_seen_at, n.capabilities_json,
      ai.installed, ai.loaded_model, ai.server_running,
      json_extract(air.state_json, '$.inference_ready') AS inference_ready
    FROM nodes AS n
    LEFT JOIN node_ai_state AS ai ON ai.node_id = n.node_id
    LEFT JOIN node_ai_runtime_state AS air ON air.node_id = n.node_id
    WHERE n.node_id = ?
  `).bind(nodeId).first();
  if (!node || operationalNodeState(node) !== "live" || isTestNodeRecord(node)) return 0;

  const canRunPython = projectNodeReady(node, "architect_python");
  const canRunAi = projectNodeReady(node, "architect_manual");
  if (!canRunPython && !canRunAi) return 0;

  const [planned, readyNodesQuery] = await Promise.all([
    env.DB.prepare(`
      SELECT w.work_item_id, w.project_id, w.sequence_no, w.role_name, w.task_text,
        w.node_id AS preferred_node_id, p.title AS project_title, p.source_type, p.checks_json,
        EXISTS (
          SELECT 1 FROM interactive_messages AS im
          WHERE im.response_work_item_id = w.work_item_id
        ) AS interactive_followup
      FROM project_work_items AS w
      JOIN architect_projects AS p ON p.project_id = w.project_id
      WHERE w.status = 'planned'
        AND p.status IN ('planned','running')
        AND (? IS NULL OR w.project_id = ?)
        AND (
          (p.source_type = 'architect_python' AND ? = 1)
          OR (p.source_type != 'architect_python' AND ? = 1)
        )
      ORDER BY CASE WHEN w.node_id = ? THEN 0 WHEN w.node_id IS NULL THEN 1 ELSE 2 END,
        datetime(p.created_at) ASC, w.sequence_no ASC
      LIMIT 32
    `).bind(projectId, projectId, canRunPython ? 1 : 0, canRunAi ? 1 : 0, nodeId).all(),
    env.DB.prepare(`
      SELECT n.node_id, n.hostname, n.status, n.last_seen_at, n.capabilities_json,
        ai.installed, ai.loaded_model, ai.server_running,
        json_extract(air.state_json, '$.inference_ready') AS inference_ready
      FROM nodes AS n
      LEFT JOIN node_ai_state AS ai ON ai.node_id = n.node_id
      LEFT JOIN node_ai_runtime_state AS air ON air.node_id = n.node_id
      WHERE n.status = 'online'
        AND datetime(n.last_seen_at) >= datetime('now', '-5 minutes')
    `).all()
  ]);
  const readyNodes = new Map((readyNodesQuery.results || []).map((candidate) => [candidate.node_id, candidate]));

  let created = 0;
  const eligible = (planned.results || []).filter((work) => {
    if (!projectNodeReady(node, work.source_type)) return false;
    if (Number(work.interactive_followup || 0) === 1) {
      return Boolean(work.preferred_node_id) && work.preferred_node_id === nodeId;
    }
    const scheduling = schedulingFromChecks(work.checks_json);
    if (scheduling.target_mode !== "auto" && scheduling.desired_workers) {
      // Explicit fanout starts with whichever distinct physical hosts are ready
      // now. A preferred node only affects ordering; it must not pin a work item
      // to a duplicate enrollment of a physical host that already participated.
      // The winning UPDATE below owns the one-host/desired-host invariants.
      return true;
    }
    const preferred = work.preferred_node_id ? readyNodes.get(work.preferred_node_id) : null;
    return !work.preferred_node_id || work.preferred_node_id === nodeId || !projectNodeReady(preferred, work.source_type);
  });
  const interactive = eligible.find((work) => Number(work.interactive_followup || 0) === 1);
  const targeted = eligible.find((work) => Number(work.interactive_followup || 0) !== 1 && schedulingFromChecks(work.checks_json).target_mode !== "auto");
  const candidates = interactive ? [interactive] : targeted ? [targeted] : eligible.slice(0, 2);

  for (const work of candidates) {
    const missionId = projectMissionId(work.work_item_id);
    const assignmentId = projectAssignmentId(work.work_item_id);
    const scheduling = schedulingFromChecks(work.checks_json);
    const enforceDistinctHost = Number(work.interactive_followup || 0) !== 1 &&
      scheduling.target_mode !== "auto" &&
      Number.isInteger(scheduling.desired_workers);
    const hostKey = String(node.hostname || "").trim().toLowerCase() || nodeId;
    const executionMode = projectExecutionMode(work.source_type);
    const missionType = executionMode === "python" ? "project_python" : "project_text";
    const taskPayloadId = drivePointerId(work.task_text);
    const taskText = taskPayloadId ? null : await resolveDriveText(env, work.task_text);
    const routingReason = work.preferred_node_id === nodeId
      ? "preferred_ready_node"
      : (work.preferred_node_id ? "preferred_node_unavailable" : "eligible_ready_node");
    const taskEnvelope = buildTaskEnvelope({
      projectId: work.project_id,
      workItemId: work.work_item_id,
      roleName: work.role_name,
      taskText: taskText || null,
      taskPayloadId,
      executionMode,
      attempt: 1,
      nodeId,
      routingReason
    });
    const payloadJson = JSON.stringify({
      project_id: work.project_id,
      work_item_id: work.work_item_id,
      role_name: work.role_name,
      task_payload_id: taskPayloadId,
      task_text: taskPayloadId ? undefined : taskText,
      execution_mode: executionMode,
      contract_version: 1,
      task_envelope: taskEnvelope
    });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE project_work_items
        SET node_id = ?, status = 'assigned', updated_at = CURRENT_TIMESTAMP
        WHERE work_item_id = ?
          AND status = 'planned'
          AND (
            ? = 0
            OR (
              NOT EXISTS (
                SELECT 1
                FROM project_work_items AS same_host
                JOIN nodes AS same_node ON same_node.node_id = same_host.node_id
                WHERE same_host.project_id = project_work_items.project_id
                  AND same_host.work_item_id != project_work_items.work_item_id
                  AND same_host.status IN ('assigned','running','completed')
                  AND (
                    CASE
                      WHEN trim(same_node.hostname) = '' THEN same_node.node_id
                      ELSE lower(trim(same_node.hostname))
                    END
                  ) = ?
              )
              AND (
                SELECT COUNT(DISTINCT (
                  CASE
                    WHEN trim(active_node.hostname) = '' THEN active_node.node_id
                    ELSE lower(trim(active_node.hostname))
                  END
                ))
                FROM project_work_items AS active
                JOIN nodes AS active_node ON active_node.node_id = active.node_id
                WHERE active.project_id = project_work_items.project_id
                  AND active.status IN ('assigned','running','completed')
              ) < ?
            )
          )
      `).bind(
        nodeId,
        work.work_item_id,
        enforceDistinctHost ? 1 : 0,
        hostKey,
        scheduling.desired_workers || 50
      ),
      env.DB.prepare(`
        INSERT OR IGNORE INTO missions (
          mission_id, title, role_name, mission_type, payload_json,
          priority, status, expires_at
        )
        SELECT ?, ?, ?, ?, ?, 40, 'assigned', ?
        WHERE EXISTS (
          SELECT 1 FROM project_work_items
          WHERE work_item_id = ? AND node_id = ? AND status = 'assigned'
        )
      `).bind(
        missionId,
        `Project: ${work.project_title} · block ${work.sequence_no}`,
        work.role_name,
        missionType,
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
        JSON.stringify({
          project_id: work.project_id,
          node_id: nodeId,
          role_name: work.role_name,
          execution_mode: executionMode,
          routing_reason: routingReason,
          task_schema: taskEnvelope.schema
        }),
        assignmentId,
        nodeId
      )
    ]);
    if ((results[0]?.meta?.changes || 0) === 1) created += 1;
  }
  return created;
}

function projectTextPreflight(taskText) {
  const text = String(taskText || "");
  const spellingWarnings = [];
  const logicWarnings = [];
  const repeatedWord = /\b([\p{L}\p{N}_-]{2,})\s+\1\b/giu.exec(text);
  if (repeatedWord) spellingWarnings.push("repeated_word:" + repeatedWord[1].slice(0, 40));
  if (/\s{3,}/u.test(text)) spellingWarnings.push("excessive_whitespace");
  if (/[!?.,]{4,}/u.test(text)) spellingWarnings.push("repeated_punctuation");
  if (/([\p{L}])\1{5,}/giu.test(text)) spellingWarnings.push("repeated_character_sequence");
  const pairs = [["(", ")"], ["[", "]"], ["{", "}"]];
  for (const [open, close] of pairs) {
    const opens = [...text].filter((ch) => ch === open).length;
    const closes = [...text].filter((ch) => ch === close).length;
    if (opens !== closes) spellingWarnings.push("unbalanced_delimiter:" + open + close);
  }
  const lowered = text.toLocaleLowerCase();
  const aiRequired = /(используй|включи|use|enable)\s+(ии|ai|lm\s*studio|llm)/iu.test(lowered);
  const aiForbidden = /(без|не\s+используй|no|without|disable)\s+(ии|ai|lm\s*studio|llm)/iu.test(lowered);
  if (aiRequired && aiForbidden) logicWarnings.push("conflicting_ai_mode_instructions");
  const pythonRequired = /(только\s+python|python\s+only|без\s+ии)/iu.test(lowered);
  const lmRequired = /(обязательно\s+lm|use\s+lm\s*studio|используй\s+lm)/iu.test(lowered);
  if (pythonRequired && lmRequired) logicWarnings.push("conflicting_python_and_lmstudio_modes");
  const nonEmptyLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (nonEmptyLines.length > 1 && new Set(nonEmptyLines.map((line) => line.toLocaleLowerCase())).size < nonEmptyLines.length) {
    logicWarnings.push("duplicate_instruction_lines");
  }
  return {
    passed: true,
    engine: "deterministic_preflight",
    spelling_warnings: spellingWarnings.slice(0, 12),
    logic_warnings: logicWarnings.slice(0, 12),
    warning_count: Math.min(24, spellingWarnings.length + logicWarnings.length),
    detail: spellingWarnings.length || logicWarnings.length ? "review_warnings_before_execution" : "no_structural_text_warnings"
  };
}

async function evaluateProjectChecks(env, sourceType, title, taskText) {
  await ensureProjectStorage(env);
  const sourceAllowed = ["architect_manual", "architect_ee", "architect_python"].includes(sourceType);
  const validationPass = title.length >= 1 && title.length <= 160 &&
    taskText.length >= 1 && taskText.length <= 20000;
  const taskSha256 = await sha256Hex(taskText);
  const duplicate = await env.DB.prepare(
    "SELECT project_id, status FROM architect_projects " +
    "WHERE task_sha256 = ? AND source_type = ? AND status IN ('planned','running') ORDER BY created_at DESC LIMIT 1"
  ).bind(taskSha256, sourceType).first();
  const safety = projectSafetyClassification(taskText);
  const textPreflight = projectTextPreflight(taskText);
  return {
    task_sha256: taskSha256,
    text_preflight: textPreflight,
    checks: {
      source_allowlisting: {
        passed: sourceAllowed,
        detail: sourceAllowed ? sourceType + "_allowed" : "source_not_allowed"
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
  const workerTarget = normalizeProjectWorkerTarget(body.worker_target);
  const executionMode = projectExecutionMode(sourceType);
  const effectiveRequestedRoles = requestedRoles;
  const result = await evaluateProjectChecks(env, sourceType, title, taskText);
  const recommendedWork = executionMode === "python"
    ? (effectiveRequestedRoles.length
        ? effectiveRequestedRoles.map((roleName, index) => ({
            sequence_no: index + 1,
            role_name: roleName,
            task_text: taskText,
            role_source: "architect_added"
          }))
        : [{ sequence_no: 1, role_name: "programmer", task_text: taskText, role_source: "hub_recommended" }])
    : planProjectWork(taskText);
  const autoDesiredWorkers = executionMode === "python" ? Math.max(1, effectiveRequestedRoles.length || 1) : projectWorkerProfile(taskText, effectiveRequestedRoles).desired_workers;
  const previewDesiredWorkers = workerTarget.mode === "fixed" ? workerTarget.count : autoDesiredWorkers;
  const plannedWork = targetProjectWork(taskText, effectiveRequestedRoles, executionMode, workerTarget.mode === "all" ? null : previewDesiredWorkers);
  const recommendedRolePlan = rolePlanSummary(recommendedWork);
  const selectedRolePlan = rolePlanSummary(plannedWork);
  return json({
    ok: true,
    execution_mode: executionMode,
    ready_for_architect_approval: projectChecksPassed(result.checks),
    recommended_role_plan: recommendedRolePlan,
    recommended_roles: Object.keys(recommendedRolePlan),
    requested_roles: effectiveRequestedRoles,
    selected_roles: Object.keys(selectedRolePlan),
    worker_target: workerTarget,
    desired_workers: workerTarget.mode === "all" ? null : previewDesiredWorkers,
    role_plan: selectedRolePlan,
    work_preview: plannedWork.map(({ sequence_no, role_name, role_source }) => ({
      sequence_no,
      role_name,
      role_source
    })),
    ...result
  });
}

/**
 * Create a durable Architect project after validation.
 * The project remains planned with unassigned work when no execution-ready node exists yet.
 */
async function architectCreateProject(request, env) {
  await authenticateArchitect(request, env);
  const body = parseJsonObject(await readBodyText(request, 64 * 1024));
  const sourceType = optionalString(body.source_type, "source_type", 40) || "architect_manual";
  const title = requireString(body.title, "title", 160);
  const taskText = requireString(body.task_text, "task_text", 20000);
  const requestedRoles = normalizeRequestedProjectRoles(body.requested_roles);
  const workerTarget = normalizeProjectWorkerTarget(body.worker_target);
  const executionMode = projectExecutionMode(sourceType);
  const effectiveRequestedRoles = requestedRoles;
  const evaluated = await evaluateProjectChecks(env, sourceType, title, taskText);
  if (!projectChecksPassed(evaluated.checks)) {
    throw new ApiError(409, "project_checks_failed");
  }

  await Promise.all([ensureNodeAiStorage(env), ensureAutoEnrollmentStorage(env)]);
  const nodesQuery = await env.DB.prepare(
    "SELECT n.node_id, n.hostname, n.status, n.last_seen_at, n.agent_version, n.capabilities_json, nn.node_number, " +
    "ai.installed AS lmstudio_installed, ai.loaded_model AS lmstudio_loaded_model, " +
    "ai.server_running AS lmstudio_server_running, " +
    "json_extract(air.state_json, '$.inference_ready') AS inference_ready " +
    "FROM nodes AS n " +
    "LEFT JOIN node_numbers AS nn ON nn.node_id = n.node_id " +
    "LEFT JOIN node_ai_state AS ai ON ai.node_id = n.node_id " +
    "LEFT JOIN node_ai_runtime_state AS air ON air.node_id = n.node_id " +
    "WHERE n.status = 'online' AND datetime(n.last_seen_at) >= datetime('now', '-5 minutes') " +
    "ORDER BY n.last_seen_at DESC, n.node_id ASC"
  ).all();
  const onlineNodes = (nodesQuery.results || []).filter((node) => !isTestNodeRecord(node));
  // A project is durable work, not a one-shot dispatch request. Save it even when
  // no executor is READY right now; normal node assignment polling will materialize
  // the planned work as soon as a compatible live worker becomes ready.
  const nodes = onlineNodes.filter((node) => projectNodeReady(node, sourceType));

  const recommendedWork = executionMode === "python"
    ? (effectiveRequestedRoles.length
        ? effectiveRequestedRoles.map((roleName, index) => ({
            sequence_no: index + 1,
            role_name: roleName,
            task_text: taskText,
            role_source: "architect_added"
          }))
        : [{ sequence_no: 1, role_name: "programmer", task_text: taskText, role_source: "hub_recommended" }])
    : planProjectWork(taskText);
  const recommendedRoles = new Set(recommendedWork.map((item) => item.role_name));
  const autoDesiredWorkers = executionMode === "python" ? Math.max(1, effectiveRequestedRoles.length || 1) : projectWorkerProfile(taskText, effectiveRequestedRoles).desired_workers;
  const desiredWorkers = workerTarget.mode === "fixed"
    ? workerTarget.count
    : workerTarget.mode === "all"
      ? Math.max(1, Math.min(50, nodes.length))
      : autoDesiredWorkers;
  const plannedWork = targetProjectWork(taskText, effectiveRequestedRoles, executionMode, desiredWorkers);
  const workerCount = Math.min(nodes.length, desiredWorkers);
  const projectId = "project_" + crypto.randomUUID();
  await ensurePayloadStorage(env);
  const createdPayloadIds = [];
  const projectTaskPayload = await persistDrivePayload(env, {
    owner_type: "project",
    owner_id: projectId,
    kind: "project_task",
    value: {
      text: taskText,
      source_type: sourceType,
      requested_roles: effectiveRequestedRoles
    }
  });
  createdPayloadIds.push(projectTaskPayload.payload_id);
  const projectTaskPointer = drivePointer(projectTaskPayload.payload_id);
  const workTaskPayloads = new Map();
  const checksJson = JSON.stringify({
    ...evaluated.checks,
    scheduling: {
      passed: true,
      detail: workerTarget.mode === "auto" ? "automatic_worker_target" : "explicit_distinct_worker_target",
      target_mode: workerTarget.mode,
      desired_workers: desiredWorkers
    }
  });
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
    ).bind(projectId, title, sourceType, projectTaskPointer, evaluated.task_sha256, checksJson, workerCount),
    env.DB.prepare(
      "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
      "VALUES ('architect', 'test-console', 'project.created', 'project', ?, ?)"
    ).bind(projectId, JSON.stringify({
      worker_count: workerCount,
      work_items: plannedWork.length,
      roles: rolePlanSummary(plannedWork),
      requested_roles: effectiveRequestedRoles,
      execution_mode: executionMode,
      worker_target: workerTarget,
      desired_workers: desiredWorkers
    }))
  ];
  for (const specialization of specializationSummary) {
    statements.push(env.DB.prepare(
      "INSERT INTO project_specializations (project_id, role_name, source) VALUES (?, ?, ?)"
    ).bind(projectId, specialization.id, specialization.source));
  }

  const workItems = [];
  for (let index = 0; index < plannedWork.length; index += 1) {
    const node = workerCount > 0
      ? (workerTarget.mode === "auto" ? nodes[index % workerCount] : (index < workerCount ? nodes[index] : null))
      : null;
    const planned = plannedWork[index];
    const workItemId = "work_" + crypto.randomUUID();
    let taskPayload = workTaskPayloads.get(planned.task_text);
    if (!taskPayload) {
      try {
        taskPayload = await persistDrivePayload(env, {
          owner_type: "project",
          owner_id: projectId,
          kind: "work_task",
          value: { text: planned.task_text }
        });
      } catch (error) {
        await Promise.all(createdPayloadIds.map((payloadId) => deletePayloadBestEffort(env, payloadId)));
        throw error;
      }
      workTaskPayloads.set(planned.task_text, taskPayload);
      createdPayloadIds.push(taskPayload.payload_id);
    }
    const taskPointer = drivePointer(taskPayload.payload_id);
    workItems.push({
      work_item_id: workItemId,
      sequence_no: planned.sequence_no,
      role_name: planned.role_name,
      node_id: node?.node_id || null,
      hostname: node?.hostname || null,
      node_number: node?.node_number || null,
      task_payload_id: taskPayload.payload_id,
      role_source: planned.role_source,
      status: "planned"
    });
    statements.push(
      env.DB.prepare(
        "INSERT INTO project_work_items (work_item_id, project_id, sequence_no, node_id, role_name, task_text, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'planned')"
      ).bind(workItemId, projectId, planned.sequence_no, node?.node_id || null, planned.role_name, taskPointer)
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    await Promise.all(createdPayloadIds.map((payloadId) => deletePayloadBestEffort(env, payloadId)));
    throw error;
  }
  return json({
    ok: true,
    project: {
      project_id: projectId,
      title,
      source_type: sourceType,
      execution_mode: executionMode,
      status: "planned",
      architect_approved: true,
      worker_count: workerCount,
      worker_target: workerTarget,
      desired_workers: desiredWorkers,
      work_item_count: plannedWork.length,
      payload_storage: "google_drive",
      task_payload_id: projectTaskPayload.payload_id,
      role_plan: rolePlanSummary(plannedWork),
      recommended_roles: [...recommendedRoles],
      requested_roles: effectiveRequestedRoles,
      specializations: specializationSummary,
      checks: evaluated.checks,
      work_items: workItems
    },
    execution: {
      state: "planned",
      execution_mode: executionMode,
      completed_work_items: 0,
      total_work_items: plannedWork.length,
      final_report_ready: false,
      worker_target: workerTarget,
      desired_workers: desiredWorkers,
      detail: workerCount === 0
        ? (executionMode === "python"
            ? "hub_plan_saved_waiting_for_python_worker"
            : "hub_plan_saved_waiting_for_ready_lmstudio_worker")
        : executionMode === "python"
          ? "hub_plan_created_waiting_for_python_worker_execution"
          : "hub_plan_created_waiting_for_project_worker_execution"
    }
  }, 201);
}

function projectListStorageMissing(error) {
  const message = String(error?.message || error || "");
  return /no such table:\s*(architect_projects|project_work_items)/i.test(message);
}

async function architectProjectListRows(env) {
  return env.DB.prepare(`
    WITH recent_projects AS (
      SELECT
        project_id, title, source_type, status, worker_count, created_at, updated_at,
        COALESCE(
          CAST(json_extract(checks_json, '$.scheduling.desired_workers') AS INTEGER),
          worker_count
        ) AS desired_workers,
        COALESCE(
          json_extract(checks_json, '$.scheduling.target_mode'),
          'auto'
        ) AS worker_target_mode
      FROM architect_projects
      WHERE NOT (
        status = 'cancelled'
        AND datetime(updated_at) < datetime('now', '-24 hours')
      )
      ORDER BY created_at DESC
      LIMIT 50
    )
    SELECT
      p.project_id, p.title, p.source_type, p.status, p.worker_count,
      p.created_at, p.updated_at, p.desired_workers, p.worker_target_mode,
      COUNT(w.work_item_id) AS work_item_count,
      SUM(CASE WHEN w.status = 'completed' THEN 1 ELSE 0 END) AS completed_work_items,
      SUM(CASE WHEN w.status = 'failed' THEN 1 ELSE 0 END) AS failed_work_items,
      SUM(CASE WHEN w.status = 'assigned' THEN 1 ELSE 0 END) AS assigned_work_items,
      SUM(CASE WHEN w.status = 'running' THEN 1 ELSE 0 END) AS running_work_items,
      SUM(CASE WHEN w.status IN ('completed','failed','cancelled') THEN 1 ELSE 0 END) AS finished_work_items
    FROM recent_projects AS p
    LEFT JOIN project_work_items AS w ON w.project_id = p.project_id
    GROUP BY
      p.project_id, p.title, p.source_type, p.status, p.worker_count,
      p.created_at, p.updated_at, p.desired_workers, p.worker_target_mode
    ORDER BY p.created_at DESC
  `).all();
}

async function architectListProjects(request, env) {
  await authenticateArchitect(request, env);

  // This is a GET/read path. Do not make it depend on schema DDL, cleanup
  // UPDATEs, or any other D1 write. When the project tables already exist,
  // listing projects must keep working even if the daily D1 write quota is
  // exhausted. A fresh database still gets the legacy runtime bootstrap once.
  let rows;
  try {
    rows = await architectProjectListRows(env);
  } catch (error) {
    if (!projectListStorageMissing(error)) throw error;
    await ensureProjectStorage(env);
    rows = await architectProjectListRows(env);
  }
  return json({ ok: true, projects: rows.results || [] });
}

async function architectGetProject(request, env, projectId, executionCtx = null) {
  await authenticateArchitect(request, env);
  await Promise.all([
    ensureProjectStorage(env),
    ensureNodeAiStorage(env),
    ensureReportStorage(env),
    ensureAutoEnrollmentStorage(env)
  ]);
  const project = await env.DB.prepare(`
    SELECT project_id, title, source_type, task_text, checks_json,
      architect_approved, status, worker_count, created_at, updated_at
    FROM architect_projects
    WHERE project_id = ?
  `).bind(projectId).first();
  if (!project) throw new ApiError(404, "project_not_found");
  const projectTaskText = await resolveDriveText(env, project.task_text);

  const readinessQuery = await env.DB.prepare(`
    SELECT
      n.node_id, n.hostname, n.agent_version, n.status, n.last_seen_at, n.capabilities_json,
      nn.node_number,
      CASE WHEN n.status = 'online'
        AND datetime(n.last_seen_at) >= datetime('now', '-5 minutes')
        THEN 1 ELSE 0 END AS recently_seen,
      ai.installed AS lmstudio_installed,
      ai.loaded_model AS lmstudio_loaded_model,
      ai.server_running AS lmstudio_server_running,
      json_extract(air.state_json, '$.inference_ready') AS inference_ready,
      json_extract(air.state_json, '$.inference_checked_at') AS inference_checked_at,
      json_extract(air.state_json, '$.inference_error') AS inference_error,
      ai.updated_at AS lmstudio_state_updated_at
    FROM nodes AS n
    LEFT JOIN node_numbers AS nn ON nn.node_id = n.node_id
    LEFT JOIN node_ai_state AS ai ON ai.node_id = n.node_id
    LEFT JOIN node_ai_runtime_state AS air ON air.node_id = n.node_id
    WHERE n.status != 'revoked'
    ORDER BY recently_seen DESC, n.last_seen_at DESC, nn.node_number ASC
    LIMIT 100
  `).all();

  const executionMode = projectExecutionMode(project.source_type);
  const workerReadiness = (readinessQuery.results || []).map((node) => {
    const capabilities = safeJson(node.capabilities_json, []);
    const hasProjectText = Array.isArray(capabilities) && capabilities.includes("project_text");
    const hasProjectPython = Array.isArray(capabilities) && capabilities.includes("project_python");
    const live = Number(node.recently_seen || 0) === 1;
    const testNode = isTestNodeRecord(node);
    const aiStateKnown = typeof node.lmstudio_state_updated_at === "string" && node.lmstudio_state_updated_at.length > 0;
    const installed = Number(node.lmstudio_installed || 0) === 1;
    const serverRunning = Number(node.lmstudio_server_running || 0) === 1;
    const loadedModel = typeof node.lmstudio_loaded_model === "string" && node.lmstudio_loaded_model.length > 0;
    const inferenceReady = Number(node.inference_ready || 0) === 1;
    const blockers = [];
    if (testNode) blockers.push("test_node_excluded");
    if (!live) blockers.push("offline");
    if (executionMode === "python") {
      if (!hasProjectPython) blockers.push(
        node.agent_version !== LATEST_NODE_RELEASE.version ? "agent_outdated" : "project_python_missing"
      );
    } else {
      if (!hasProjectText) blockers.push(
        !agentVersionAtLeast(node.agent_version, "0.3.19") ? "agent_outdated" : "project_text_missing"
      );
      if (!aiStateKnown) {
        blockers.push("lmstudio_state_unknown");
      } else if (!installed) {
        blockers.push("lmstudio_not_installed");
      } else {
        if (!serverRunning) blockers.push("lmstudio_server_stopped");
        if (!loadedModel) blockers.push("lmstudio_model_not_loaded");
        if (serverRunning && loadedModel && !inferenceReady) blockers.push("lmstudio_inference_unverified");
      }
    }
    return {
      node_id: node.node_id,
      node_number: node.node_number || null,
      hostname: node.hostname || null,
      agent_version: node.agent_version || null,
      live,
      operational_state: testNode ? "test" : operationalNodeState(node),
      execution_mode: executionMode,
      project_text: hasProjectText,
      project_python: hasProjectPython,
      lmstudio_state_known: aiStateKnown,
      lmstudio_state_updated_at: node.lmstudio_state_updated_at || null,
      lmstudio_installed: installed,
      lmstudio_server_running: serverRunning,
      lmstudio_loaded_model: node.lmstudio_loaded_model || null,
      lmstudio_inference_ready: inferenceReady,
      lmstudio_inference_checked_at: node.inference_checked_at || null,
      lmstudio_inference_error: node.inference_error || null,
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

  const [workQuery, specializationQuery, taskLogQuery] = await Promise.all([
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
    `).bind(projectId).all(),
    env.DB.prepare(`
      SELECT event_id, actor_type, action, target_type, target_id, details_json, created_at
      FROM audit_events
      WHERE target_id = ? OR instr(details_json, ?) > 0
      ORDER BY event_id ASC
      LIMIT 250
    `).bind(projectId, projectId).all()
  ]);

  const taskLogs = (taskLogQuery.results || []).map((event) => ({
    event_id: event.event_id,
    actor_type: event.actor_type,
    action: event.action,
    target_type: event.target_type,
    target_id: event.target_id,
    details: safeJson(event.details_json, {}),
    created_at: event.created_at
  }));

  const textCache = new Map();
  const jsonCache = new Map();
  const resolveCachedText = (value) => {
    const key = String(value || "");
    if (!textCache.has(key)) textCache.set(key, resolveDriveText(env, value));
    return textCache.get(key);
  };
  const resolveCachedJson = (value) => {
    const key = String(value || "");
    if (!jsonCache.has(key)) jsonCache.set(key, resolveDriveJson(env, value));
    return jsonCache.get(key);
  };
  const workItems = await Promise.all((workQuery.results || []).map(async (item) => ({
    ...item,
    task_text: await resolveCachedText(item.task_text),
    result: item.result_json ? await resolveCachedJson(item.result_json) : null,
    result_json: undefined
  })));
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
      content: typeof item.result.content === "string" && item.result.content.trim()
        ? item.result.content
        : item.status === "failed"
          ? `ERROR: ${String(item.result.error_code || item.result.error_type || "worker_failed")}`
          : null,
      error_code: typeof item.result.error_code === "string" ? item.result.error_code : null,
      status: item.status
    }));
  const workComplete = total > 0 && finished === total;
  const rawResultText = workComplete ? projectFinalText(finalSections) : null;
  const qualityConfig = openRouterQualityConfig(env);
  let qualityGate = workComplete && executionMode === "python"
    ? {
        ready: true,
        status: "not_applicable_python",
        content: rawResultText,
        reviewed: false,
        model: null,
        error_code: null
      }
    : workComplete
      ? await projectQualityGateSnapshot(env, project.project_id, projectTaskText, rawResultText)
      : {
          ready: false,
          status: "waiting_for_workers",
          content: null,
          reviewed: false,
          model: null,
          error_code: null
        };

  if (
    workComplete &&
    executionMode !== "python" &&
    qualityConfig.configured &&
    !qualityGate.reviewed &&
    qualityGate.status !== "degraded" &&
    executionCtx &&
    typeof executionCtx.waitUntil === "function"
  ) {
    const backgroundReview = finalizeProjectAnswer(
      env,
      project.project_id,
      projectTaskText,
      rawResultText
    ).catch((error) => {
      console.error("Background OpenRouter quality gate failed", error);
    });
    executionCtx.waitUntil(backgroundReview);
    if (qualityGate.status === "deferred") {
      qualityGate = {
        ...qualityGate,
        status: "processing"
      };
    }
  }
  // A completed local worker result is the baseline answer. OpenRouter may
  // enrich it, but a slow/processing quality gate must never hide it.
  const finalResultText = workComplete ? (qualityGate.content || rawResultText || null) : null;
  const finalReportReady = workComplete && Boolean(finalResultText);
  return json({
    ok: true,
    project: {
      ...project,
      task_text: projectTaskText,
      payload_storage: drivePointerId(project.task_text) ? "google_drive" : "legacy_d1",
      checks: safeJson(project.checks_json, {}),
      checks_json: undefined,
      role_plan: rolePlanSummary(workItems),
      specializations,
      work_items: workItems,
      execution: {
        state: executionState,
        counts,
        execution_mode: executionMode,
        desired_workers: schedulingFromChecks(project.checks_json).desired_workers ||
          (executionMode === "python"
            ? 1
            : projectWorkerProfile(projectTaskText, specializations.filter((item) => item.source === "architect_added").map((item) => item.id)).desired_workers),
        worker_target_mode: schedulingFromChecks(project.checks_json).target_mode,
        ready_workers_at_creation: Number(project.worker_count || 0),
        ready_workers_now: readyWorkers.length,
        worker_readiness: workerReadiness,
        completed_work_items: counts.completed,
        total_work_items: total,
        final_report_ready: finalReportReady,
        progress_percent: total ? Math.round((finished / total) * 100) : 0,
        detail: workComplete && qualityGate.status === "processing" && finalReportReady
          ? "local_result_ready_quality_gate_running"
          : workComplete && !finalReportReady
            ? "final_quality_gate_running"
          : finalReportReady && qualityGate.reviewed
            ? "final_quality_gate_completed"
            : finalReportReady && qualityGate.status === "degraded"
              ? "final_quality_gate_degraded"
              : executionState === "planned"
                ? (executionMode === "python" ? "waiting_for_python_project_worker" : "waiting_for_lmstudio_project_worker")
                : executionState === "completed"
                  ? "all_project_work_items_completed"
                  : executionState
      },
      text_preflight: projectTextPreflight(projectTaskText),
      task_logs: taskLogs,
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
    ["query_id", 160], ["query_mode", 32], ["query_status", 32], ["operation_id", 160],
    ["query_prompt", 8000], ["query_answer", 65536], ["live_checked_at", 64],
    ["inference_model", 192], ["inference_checked_at", 64], ["inference_error", 256]
  ];
  const out = {
    installed: value.installed === true || value.installed === 1 ? 1 : 0,
    server_running: value.server_running === true || value.server_running === 1 ? 1 : 0,
    inference_ready: value.inference_ready === true || value.inference_ready === 1 ? 1 : 0
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

async function claimSyncReplayNonce(env, nodeId, requestId, timestampSeconds) {
  if (!env.SSH_RELAY) return null;
  try {
    // Honor claims made by a D1-only deployment before switching stores. This
    // indexed read adds no nonce writes and must not hide storage failures.
    try {
      const previous = await env.DB.prepare(
        "SELECT 1 AS used FROM node_request_nonces WHERE node_id = ? AND request_id = ?"
      ).bind(nodeId, requestId).first();
      if (previous) return false;
    } catch (error) {
      if (!/no such table:\s*node_request_nonces/i.test(String(error?.message || error))) throw error;
    }
    const expires = Math.max(Math.floor(Date.now() / 1000) + SIGNATURE_WINDOW_SECONDS + 30,
      timestampSeconds + SIGNATURE_WINDOW_SECONDS + 1);
    const response = await relayStub(env, nodeId).fetch("https://relay.internal/replay-claim", {
      method: "POST",
      headers: {
        "x-citadel-relay-role": "replay",
        "x-citadel-request-id": requestId,
        "x-citadel-request-expires": String(expires)
      }
    });
    if (response.status === 409) return false;
    if (response.status === 201) return true;
    console.warn("node_replay_claim_failed", "replay_relay_http_" + response.status);
  } catch (error) {
    console.warn("node_replay_claim_failed", replayFailureCode(error));
    // The claim may have committed before a response was lost. Switching to
    // an independent D1 store here would accept a replay already used in DO.
  }
  throw new ApiError(503, "node_replay_store_unavailable");
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
    "SELECT node_id, public_key, status, agent_version, os_name FROM nodes WHERE node_id = ?"
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
    // Use the per-node Durable Object as the primary atomic replay store for
    // every signed modern node request. D1-only deployments remain compatible;
    // a configured but unavailable DO fails closed instead of switching stores.
    const durableClaim = await claimSyncReplayNonce(env, nodeId, requestId, timestampSeconds);
    if (durableClaim === false) {
      throw new ApiError(409, "replayed_request");
    }
    if (durableClaim !== true) {
      await ensureNodeRequestNonceStorage(env);
      const nonce = await env.DB.prepare(
        "INSERT OR IGNORE INTO node_request_nonces (node_id, request_id) VALUES (?, ?)"
      ).bind(nodeId, requestId).run();
      if ((nonce?.meta?.changes || 0) !== 1) {
        throw new ApiError(409, "replayed_request");
      }
      // Replay protection is enforced by the PRIMARY KEY insert above. Cleanup
      // can be opportunistic: retaining expired nonces longer is safe, while
      // pruning on every signed poll caused repeated D1 scans.
      if (requestId.endsWith("0")) {
        await env.DB.prepare(
          "DELETE FROM node_request_nonces WHERE received_at < datetime('now', '-10 minutes')"
        ).run();
      }
    }
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
  const node = await authenticateNode(request, env, nodeId, url, bodyBytes);
  const body = parseJsonObject(bodyText);
  return json(await persistHeartbeat(env, node, body, true));
}

async function persistHeartbeat(env, node, body, coalesce = false) {
  const nodeId = node.node_id;

  const cpuPercent = optionalPercent(body.cpu_percent, "cpu_percent");
  const memoryPercent = optionalPercent(body.memory_percent, "memory_percent");
  const agentVersion = optionalString(body.agent_version, "agent_version", 80);
  const capabilitiesJson = body.capabilities === undefined
    ? null
    : normalizeCapabilities(body.capabilities);
  const network = normalizeNodeNetwork(body.network);
  const hardware = normalizeNodeHardware(body.hardware);
  const ssh = normalizeNodeSsh(body.ssh, node.os_name);
  if (network) await ensureNodeNetworkStorage(env);
  if (hardware) await ensureNodeHardwareStorage(env);
  if (ssh) await ensureNodeSshStorage(env);
  const heartbeatAt = new Date().toISOString();
  const heartbeatStatements = [
    env.DB.prepare(`
      UPDATE nodes
      SET cpu_percent = COALESCE(?, cpu_percent),
          memory_percent = COALESCE(?, memory_percent),
          agent_version = COALESCE(?, agent_version),
          capabilities_json = COALESCE(?, capabilities_json),
          status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'online' END,
          last_seen_at = ?
      WHERE node_id = ? AND status != 'revoked'
        AND (? = 0 OR datetime(last_seen_at) <= datetime(?, '-240 seconds')
          OR status NOT IN ('online','paused')
          OR agent_version IS NOT COALESCE(?, agent_version)
          OR capabilities_json IS NOT COALESCE(?, capabilities_json))
    `).bind(cpuPercent, memoryPercent, agentVersion, capabilitiesJson, heartbeatAt, nodeId,
      coalesce ? 1 : 0, heartbeatAt, agentVersion, capabilitiesJson)
  ];
  if (network) {
    heartbeatStatements.push(env.DB.prepare(`
      INSERT INTO node_network_state (
        node_id, lan_ipv4, mac_addresses_json, updated_at
      ) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(node_id) DO UPDATE SET
        lan_ipv4 = COALESCE(excluded.lan_ipv4, node_network_state.lan_ipv4),
        mac_addresses_json = CASE
          WHEN excluded.mac_addresses_json != '[]' THEN excluded.mac_addresses_json
          ELSE node_network_state.mac_addresses_json
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE node_network_state.lan_ipv4 IS NOT COALESCE(excluded.lan_ipv4, node_network_state.lan_ipv4)
        OR (excluded.mac_addresses_json != '[]'
          AND node_network_state.mac_addresses_json IS NOT excluded.mac_addresses_json)
    `).bind(
      nodeId,
      network.lan_ipv4,
      JSON.stringify(network.mac_addresses)
    ));
  }
  if (hardware) {
    heartbeatStatements.push(env.DB.prepare(`
      INSERT INTO node_hardware_state (
        node_id, memory_total_bytes, cpu_logical_count, gpus_json, updated_at
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(node_id) DO UPDATE SET
        memory_total_bytes = excluded.memory_total_bytes,
        cpu_logical_count = excluded.cpu_logical_count,
        gpus_json = excluded.gpus_json,
        updated_at = CURRENT_TIMESTAMP
      WHERE node_hardware_state.memory_total_bytes IS NOT excluded.memory_total_bytes
        OR node_hardware_state.cpu_logical_count IS NOT excluded.cpu_logical_count
        OR node_hardware_state.gpus_json IS NOT excluded.gpus_json
    `).bind(
      nodeId,
      hardware.memory_total_bytes,
      hardware.cpu_logical_count,
      JSON.stringify(hardware.gpus)
    ));
  }
  if (ssh) {
    heartbeatStatements.push(env.DB.prepare(`
      INSERT INTO node_ssh_state (
        node_id, ssh_client_available, sshd_process_running, sshd_listening_local,
        sshd_exposure_verified, sshd_loopback_only,
        cloudflared_installed, cloudflared_running,
        restricted_bootstrap_state_present, restricted_console_installed,
        cloudflare_ca_public_key_present, sshd_force_command_managed, restricted_policy_ready,
        browser_terminal_local_ready,
        bind_target, observed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(node_id) DO UPDATE SET
        ssh_client_available = excluded.ssh_client_available,
        sshd_process_running = excluded.sshd_process_running,
        sshd_listening_local = excluded.sshd_listening_local,
        sshd_exposure_verified = excluded.sshd_exposure_verified,
        sshd_loopback_only = excluded.sshd_loopback_only,
        cloudflared_installed = excluded.cloudflared_installed,
        cloudflared_running = excluded.cloudflared_running,
        restricted_bootstrap_state_present = excluded.restricted_bootstrap_state_present,
        restricted_console_installed = excluded.restricted_console_installed,
        cloudflare_ca_public_key_present = excluded.cloudflare_ca_public_key_present,
        sshd_force_command_managed = excluded.sshd_force_command_managed,
        restricted_policy_ready = excluded.restricted_policy_ready,
        browser_terminal_local_ready = excluded.browser_terminal_local_ready,
        bind_target = excluded.bind_target,
        observed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE node_ssh_state.ssh_client_available IS NOT excluded.ssh_client_available
        OR node_ssh_state.sshd_process_running IS NOT excluded.sshd_process_running
        OR node_ssh_state.sshd_listening_local IS NOT excluded.sshd_listening_local
        OR node_ssh_state.sshd_exposure_verified IS NOT excluded.sshd_exposure_verified
        OR node_ssh_state.sshd_loopback_only IS NOT excluded.sshd_loopback_only
        OR node_ssh_state.cloudflared_installed IS NOT excluded.cloudflared_installed
        OR node_ssh_state.cloudflared_running IS NOT excluded.cloudflared_running
        OR node_ssh_state.restricted_bootstrap_state_present IS NOT excluded.restricted_bootstrap_state_present
        OR node_ssh_state.restricted_console_installed IS NOT excluded.restricted_console_installed
        OR node_ssh_state.cloudflare_ca_public_key_present IS NOT excluded.cloudflare_ca_public_key_present
        OR node_ssh_state.sshd_force_command_managed IS NOT excluded.sshd_force_command_managed
        OR node_ssh_state.restricted_policy_ready IS NOT excluded.restricted_policy_ready
        OR node_ssh_state.browser_terminal_local_ready IS NOT excluded.browser_terminal_local_ready
        OR node_ssh_state.bind_target IS NOT excluded.bind_target
        OR node_ssh_state.observed_at IS NULL
    `).bind(
      nodeId,
      ssh.ssh_client_available,
      ssh.sshd_process_running,
      ssh.sshd_listening_local,
      ssh.sshd_exposure_verified,
      ssh.sshd_loopback_only,
      ssh.cloudflared_installed,
      ssh.cloudflared_running,
      ssh.restricted_bootstrap_state_present,
      ssh.restricted_console_installed,
      ssh.cloudflare_ca_public_key_present,
      ssh.sshd_force_command_managed,
      ssh.restricted_policy_ready,
      ssh.browser_terminal_local_ready,
      ssh.bind_target
    ));
  }
  const results = await env.DB.batch(heartbeatStatements);

  if (!coalesce && (results[0]?.meta?.changes || 0) !== 1) {
    throw new ApiError(404, "node_not_found");
  }

  // authenticateNode already loaded the current status. The UPDATE above can
  // only preserve paused or move a non-revoked node to online, so a second
  // point SELECT just to echo the heartbeat would double-read this hot path.
  const status = node.status === "paused" ? "paused" : "online";
  if (node.status === "offline" && results[0]?.meta?.changes === 1) {
    await recordOperationalReport(env, nodeId, "node_connected", {agent_version: agentVersion || node.agent_version}, heartbeatAt);
  }
  return { ok: true, node_id: nodeId, status, last_seen_at: heartbeatAt };
}

async function listAssignments(request, env, nodeId, url) {
  const node = await authenticateNode(request, env, nodeId, url, new Uint8Array(0));
  return json(await assignmentsForNode(env, node));
}

async function assignmentsForNode(env, node) {
  const nodeId = node.node_id;

  if (node.status === "paused") {
    return { ok: true, node_status: "paused", assignments: [] };
  }

  await recoverStaleProjectAssignments(env);
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

  const assignments = await Promise.all((query.results || []).map(async (row) => {
    const payload = safeJson(row.payload_json, {});
    if (payload && typeof payload === "object" && payload.task_payload_id && !payload.task_text) {
      payload.task_text = await resolveDriveText(env, drivePointer(payload.task_payload_id));
      if (payload.task_envelope && typeof payload.task_envelope === "object") {
        payload.task_envelope = {
          ...payload.task_envelope,
          goal: payload.task_text,
          goal_payload_id: payload.task_payload_id
        };
      }
    }
    return {
      ...row,
      payload,
      payload_json: undefined
    };
  }));
  return { ok: true, node_status: node.status, assignments };
}

// One authenticated envelope replaces separate command, heartbeat, AI and work
// polls. Legacy routes retain their existing authentication and response shape.
// Stable sync heartbeats persist at most once every four minutes; live relay
// connectivity and 30-second sync reads keep control responsive without D1 write churn.
async function syncNode(request, env, nodeId, url) {
  const { bytes, text } = await readBody(request, 192 * 1024);
  const node = await authenticateNode(request, env, nodeId, url, bytes);
  const body = parseJsonObject(text);
  const ai = body.ai === undefined ? null : normalizeAiState(body.ai);
  if (body.heartbeat !== undefined) {
    if (!body.heartbeat || typeof body.heartbeat !== "object" || Array.isArray(body.heartbeat)) {
      throw new ApiError(400, "invalid_heartbeat");
    }
    const heartbeatState = await persistHeartbeat(env, node, body.heartbeat, true);
    node.status = heartbeatState.status;
    node.agent_version = body.heartbeat.agent_version || node.agent_version;
  }
  if (ai) await upsertNodeAiState(env, nodeId, ai);
  const commands = await commandsForNode(env, node);
  // Do not reserve work before the agent processes a pending control command.
  const work = commands.commands.length || body.paused === true
    ? { assignments: [] }
    : await assignmentsForNode(env, node);
  return json({ ok: true, node_status: node.status, commands: commands.commands,
    assignments: work.assignments });
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
  const summaryIndex = summary ? summary.slice(0, 512) : null;
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
  const reportPayload = await persistDrivePayload(env, {
    owner_type: "report",
    owner_id: reportId,
    kind: "agent_report",
    value: reportValue,
    node_id: nodeId
  });
  const reportPointer = drivePointer(reportPayload.payload_id);
  const effectiveArtifactKey = artifactKey || ("gdrive:" + reportPayload.drive_file_id);
  const assignmentStatus = outcome === "failed" ? "failed" : "completed";

  const isProjectAssignment = assignmentId.startsWith("assignment_work_");
  if (isProjectAssignment) await ensureProjectStorage(env);
  const workItemId = isProjectAssignment ? assignmentId.slice("assignment_".length) : null;
  const workContext = workItemId
    ? await env.DB.prepare(`
        SELECT w.project_id, w.role_name, p.source_type
        FROM project_work_items AS w
        JOIN architect_projects AS p ON p.project_id = w.project_id
        WHERE w.work_item_id = ?
        LIMIT 1
      `).bind(workItemId).first()
    : null;
  const resultEnvelope = workContext
    ? buildResultEnvelope({
        projectId: workContext.project_id,
        workItemId,
        assignmentId,
        nodeId,
        roleName: workContext.role_name,
        executionMode: projectExecutionMode(workContext.source_type),
        outcome,
        report: reportValue,
        reportSha256,
        reportSizeBytes
      })
    : null;
  const structuralVerification = resultEnvelope
    ? verifyProjectResultEnvelope(resultEnvelope, reportValue)
    : null;
  const detailsJson = JSON.stringify({
    result_id: resultId,
    outcome,
    result_envelope: resultEnvelope,
    structural_verification: structuralVerification
  });

  const interactiveLink = workItemId
    ? await env.DB.prepare(`
        SELECT im.thread_id, t.message_count
        FROM interactive_messages AS im
        JOIN interactive_threads AS t ON t.thread_id = im.thread_id
        WHERE im.response_work_item_id = ? AND im.actor = 'user'
        ORDER BY im.sequence_no DESC
        LIMIT 1
      `).bind(workItemId).first()
    : null;

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
      summaryIndex,
      effectiveArtifactKey,
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
      reportPointer,
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

  if (interactiveLink?.thread_id) {
    const agentSequence = Number(interactiveLink.message_count || 0) + 1;
    resultStatements.push(
      env.DB.prepare(`
        INSERT INTO interactive_messages (
          message_id, thread_id, sequence_no, actor, payload_id
        ) VALUES (?, ?, ?, 'agent', ?)
      `).bind(
        "message_" + crypto.randomUUID(),
        interactiveLink.thread_id,
        agentSequence,
        reportPayload.payload_id
      ),
      env.DB.prepare(`
        UPDATE interactive_threads
        SET message_count = CASE WHEN message_count < ? THEN ? ELSE message_count END,
            updated_at = CURRENT_TIMESTAMP
        WHERE thread_id = ?
      `).bind(agentSequence, agentSequence, interactiveLink.thread_id)
    );
  }

  if (resultEnvelope && structuralVerification) {
    resultStatements.push(
      env.DB.prepare(`
        INSERT INTO audit_events (
          actor_type, actor_id, action, target_type, target_id, details_json
        )
        SELECT 'controller', 'structural-verifier-v1', 'project.result.structural_verification',
          'project_work_item', ?, ?
        WHERE EXISTS (SELECT 1 FROM results WHERE result_id = ?)
      `).bind(
        workItemId,
        JSON.stringify({
          result_id: resultId,
          envelope: resultEnvelope,
          verification: structuralVerification
        }),
        resultId
      )
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
    await deletePayloadBestEffort(env, reportPayload.payload_id);
    if (String(error).includes("results.assignment_id")) {
      throw new ApiError(409, "result_already_exists");
    }
    throw error;
  }

  if ((statements[0]?.meta?.changes || 0) !== 1) {
    await deletePayloadBestEffort(env, reportPayload.payload_id);
    throw new ApiError(409, "assignment_not_active");
  }

  return json({
    ok: true,
    result: {
      result_id: resultId,
      report_id: reportId,
      report_payload_id: reportPayload.payload_id,
      assignment_id: assignmentId,
      outcome,
      contract: resultEnvelope,
      structural_verification: structuralVerification
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

  const content = await resolveDriveJson(env, report.report_json);
  if (drivePointerId(report.report_json)) {
    const serialized = JSON.stringify(content);
    const sizeBytes = new TextEncoder().encode(serialized).byteLength;
    if (sizeBytes !== Number(report.report_size_bytes) || (await sha256Hex(serialized)) !== report.report_sha256) {
      throw new ApiError(502, "drive_report_integrity_mismatch");
    }
  }
  return json({
    ok: true,
    report: {
      ...report,
      storage: drivePointerId(report.report_json) ? "google_drive" : "legacy_d1",
      metrics: safeJson(report.metrics_json, {}),
      content,
      metrics_json: undefined,
      report_json: undefined
    }
  });
}


function interactivePayloadText(payload) {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.content === "string") return payload.content;
  if (typeof payload.summary === "string") return payload.summary;
  if (typeof payload.error_code === "string") return "ERROR: " + payload.error_code;
  const serialized = JSON.stringify(payload);
  return serialized.length <= 4000 ? serialized : serialized.slice(0, 4000) + "…";
}

async function interactiveThreadBase(env, projectId, workItemId) {
  await Promise.all([ensureProjectStorage(env), ensureReportStorage(env), ensurePayloadStorage(env)]);
  const base = await env.DB.prepare(`
    SELECT
      w.work_item_id, w.project_id, w.node_id, w.role_name, w.status AS work_status,
      p.source_type, p.status AS project_status, p.title,
      n.hostname,
      (
        SELECT ar.report_json
        FROM agent_reports AS ar
        WHERE ar.assignment_id = ('assignment_' || w.work_item_id)
        ORDER BY datetime(ar.created_at) DESC
        LIMIT 1
      ) AS result_json
    FROM project_work_items AS w
    JOIN architect_projects AS p ON p.project_id = w.project_id
    LEFT JOIN nodes AS n ON n.node_id = w.node_id
    WHERE w.project_id = ? AND w.work_item_id = ?
  `).bind(projectId, workItemId).first();
  if (!base) throw new ApiError(404, "project_work_item_not_found");
  if (!base.node_id) throw new ApiError(409, "interactive_worker_not_assigned");
  return base;
}

async function ensureInteractiveThread(env, projectId, workItemId) {
  const base = await interactiveThreadBase(env, projectId, workItemId);
  let thread = await env.DB.prepare(`
    SELECT thread_id, project_id, work_item_id, node_id, role_name, execution_mode,
      status, message_count, created_at, updated_at
    FROM interactive_threads
    WHERE project_id = ? AND work_item_id = ?
  `).bind(projectId, workItemId).first();

  if (!thread) {
    const threadId = "thread_" + crypto.randomUUID();
    await env.DB.prepare(`
      INSERT OR IGNORE INTO interactive_threads (
        thread_id, project_id, work_item_id, node_id, role_name, execution_mode
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      threadId,
      projectId,
      workItemId,
      base.node_id,
      base.role_name,
      projectExecutionMode(base.source_type)
    ).run();
    thread = await env.DB.prepare(`
      SELECT thread_id, project_id, work_item_id, node_id, role_name, execution_mode,
        status, message_count, created_at, updated_at
      FROM interactive_threads
      WHERE project_id = ? AND work_item_id = ?
    `).bind(projectId, workItemId).first();
  }

  if (!thread) throw new ApiError(500, "interactive_thread_create_failed");

  if (Number(thread.message_count || 0) === 0 && base.result_json) {
    let initialPayloadId = drivePointerId(base.result_json);
    let createdPayloadId = null;
    if (!initialPayloadId) {
      const legacyResult = safeJson(base.result_json, null);
      if (legacyResult) {
        const migrated = await persistDrivePayload(env, {
          owner_type: "thread",
          owner_id: thread.thread_id,
          kind: "legacy_initial_agent_report",
          value: legacyResult
        });
        initialPayloadId = migrated.payload_id;
        createdPayloadId = migrated.payload_id;
      }
    }
    if (initialPayloadId) {
      try {
        const inserted = await env.DB.prepare(`
          INSERT OR IGNORE INTO interactive_messages (
            message_id, thread_id, sequence_no, actor, payload_id
          ) VALUES (?, ?, 1, 'agent', ?)
        `).bind("message_" + crypto.randomUUID(), thread.thread_id, initialPayloadId).run();
        if ((inserted?.meta?.changes || 0) === 1) {
          await env.DB.prepare(`
            UPDATE interactive_threads
            SET message_count = 1, updated_at = CURRENT_TIMESTAMP
            WHERE thread_id = ?
          `).bind(thread.thread_id).run();
        } else if (createdPayloadId) {
          await deletePayloadBestEffort(env, createdPayloadId);
        }
      } catch (error) {
        if (createdPayloadId) await deletePayloadBestEffort(env, createdPayloadId);
        throw error;
      }
    }
  }

  const refreshed = await env.DB.prepare(`
    SELECT thread_id, project_id, work_item_id, node_id, role_name, execution_mode,
      status, message_count, created_at, updated_at
    FROM interactive_threads
    WHERE thread_id = ?
  `).bind(thread.thread_id).first();
  return {
    ...(refreshed || thread),
    hostname: base.hostname || null,
    source_type: base.source_type,
    project_status: base.project_status,
    work_status: base.work_status
  };
}

async function interactiveThreadMessages(env, threadId) {
  const query = await env.DB.prepare(`
    SELECT message_id, sequence_no, actor, payload_id, response_work_item_id, created_at
    FROM interactive_messages
    WHERE thread_id = ?
    ORDER BY sequence_no ASC
    LIMIT 200
  `).bind(threadId).all();
  return Promise.all((query.results || []).map(async (message) => {
    const payload = await readDrivePayload(env, message.payload_id);
    return {
      ...message,
      text: interactivePayloadText(payload)
    };
  }));
}

async function architectGetInteractiveThread(request, env, projectId, workItemId) {
  await authenticateArchitect(request, env);
  const thread = await ensureInteractiveThread(env, projectId, workItemId);
  const [messages, pendingRow] = await Promise.all([
    interactiveThreadMessages(env, thread.thread_id),
    env.DB.prepare(`
      SELECT COUNT(*) AS pending
      FROM project_work_items AS w
      WHERE w.work_item_id IN (
        SELECT response_work_item_id
        FROM interactive_messages
        WHERE thread_id = ? AND actor = 'user' AND response_work_item_id IS NOT NULL
      )
        AND w.status IN ('planned','assigned','running')
    `).bind(thread.thread_id).first()
  ]);
  return json({
    ok: true,
    thread: {
      ...thread,
      role: roleMetadata(thread.role_name),
      pending_responses: Number(pendingRow?.pending || 0),
      messages
    }
  });
}

async function architectPostInteractiveMessage(request, env, projectId, workItemId) {
  await authenticateArchitect(request, env);
  const body = parseJsonObject(await readBodyText(request, 16 * 1024));
  const messageText = requireString(body.message, "interactive_message", 8000);
  const thread = await ensureInteractiveThread(env, projectId, workItemId);
  if (thread.status !== "active") throw new ApiError(409, "interactive_thread_closed");
  if (thread.project_status === "cancelled") throw new ApiError(409, "project_cancelled");

  const historyRows = await env.DB.prepare(`
    SELECT sequence_no, actor, payload_id
    FROM interactive_messages
    WHERE thread_id = ?
    ORDER BY sequence_no DESC
    LIMIT 12
  `).bind(thread.thread_id).all();
  const history = (await Promise.all(
    (historyRows.results || []).reverse().map(async (row) => ({
      actor: row.actor,
      text: interactivePayloadText(await readDrivePayload(env, row.payload_id))
    }))
  )).filter((item) => item.text);

  const userPayload = await persistDrivePayload(env, {
    owner_type: "thread",
    owner_id: thread.thread_id,
    kind: "user_message",
    value: { text: messageText }
  });
  const createdPayloadIds = [userPayload.payload_id];

  let taskText = messageText;
  let taskPayload = userPayload;
  if (thread.execution_mode === "ai") {
    const historyText = history
      .slice(-10)
      .map((item) => (item.actor === "user" ? "USER" : "AGENT") + ": " + item.text)
      .join("\n\n")
      .slice(-12000);
    taskText = [
      "Continue the same CITADEL interactive report with the same expert role and the same node.",
      "Role: " + thread.role_name,
      "Do not restart the analysis from zero. Answer the user's follow-up using the prior report/dialogue context.",
      historyText ? "Conversation so far:\n" + historyText : "",
      "USER FOLLOW-UP:\n" + messageText
    ].filter(Boolean).join("\n\n");
    try {
      taskPayload = await persistDrivePayload(env, {
        owner_type: "thread",
        owner_id: thread.thread_id,
        kind: "followup_task",
        value: { text: taskText }
      });
    } catch (error) {
      await deletePayloadBestEffort(env, userPayload.payload_id);
      throw error;
    }
    createdPayloadIds.push(taskPayload.payload_id);
  }

  const sequenceRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(sequence_no), 0) AS max_sequence FROM project_work_items WHERE project_id = ?"
  ).bind(projectId).first();
  const messageSequenceRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(sequence_no), 0) AS max_sequence FROM interactive_messages WHERE thread_id = ?"
  ).bind(thread.thread_id).first();
  const workSequence = Number(sequenceRow?.max_sequence || 0) + 1;
  const messageSequence = Number(messageSequenceRow?.max_sequence || 0) + 1;
  const responseWorkItemId = "work_" + crypto.randomUUID();
  const taskPointer = drivePointer(taskPayload.payload_id);

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO project_work_items (
          work_item_id, project_id, sequence_no, node_id, role_name, task_text, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'planned')
      `).bind(
        responseWorkItemId,
        projectId,
        workSequence,
        thread.node_id,
        thread.role_name,
        taskPointer
      ),
      env.DB.prepare(`
        INSERT INTO interactive_messages (
          message_id, thread_id, sequence_no, actor, payload_id, response_work_item_id
        ) VALUES (?, ?, ?, 'user', ?, ?)
      `).bind(
        "message_" + crypto.randomUUID(),
        thread.thread_id,
        messageSequence,
        userPayload.payload_id,
        responseWorkItemId
      ),
      env.DB.prepare(`
        UPDATE interactive_threads
        SET message_count = message_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE thread_id = ?
      `).bind(thread.thread_id),
      env.DB.prepare(`
        UPDATE architect_projects
        SET status = 'running', updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ? AND status IN ('planned','running','completed','blocked')
      `).bind(projectId),
      env.DB.prepare(`
        INSERT INTO audit_events (
          actor_type, actor_id, action, target_type, target_id, details_json
        ) VALUES ('architect', 'interactive-report', 'interactive.message.created',
          'interactive_thread', ?, ?)
      `).bind(thread.thread_id, JSON.stringify({
        project_id: projectId,
        work_item_id: responseWorkItemId,
        node_id: thread.node_id,
        role_name: thread.role_name,
        execution_mode: thread.execution_mode
      }))
    ]);
  } catch (error) {
    await Promise.all(createdPayloadIds.map((payloadId) => deletePayloadBestEffort(env, payloadId)));
    throw error;
  }

  let materialized = 0;
  try {
    materialized = await materializeProjectWorkForNode(env, thread.node_id, projectId);
  } catch {
    materialized = 0;
  }
  const queued = await env.DB.prepare(
    "SELECT status FROM project_work_items WHERE work_item_id = ?"
  ).bind(responseWorkItemId).first();

  return json({
    ok: true,
    thread_id: thread.thread_id,
    response_work_item_id: responseWorkItemId,
    state: queued?.status || (materialized ? "assigned" : "planned"),
    node_id: thread.node_id,
    role_name: thread.role_name,
    execution_mode: thread.execution_mode
  }, 202);
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
  const snapshotPayload = await persistDrivePayload(env, {
    owner_type: "session",
    owner_id: sessionId,
    kind: "session_snapshot",
    value: snapshot
  });
  const snapshotPointer = drivePointer(snapshotPayload.payload_id);
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO architect_sessions (
          session_id, name, schema_version, snapshot_json, snapshot_sha256,
          snapshot_size_bytes, status, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, 'active', ?, ?)
      `).bind(
        sessionId,
        name,
        snapshotPointer,
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
  } catch (error) {
    await deletePayloadBestEffort(env, snapshotPayload.payload_id);
    throw error;
  }

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
  const snapshot = await resolveDriveJson(env, session.snapshot_json);
  if (drivePointerId(session.snapshot_json)) {
    const serialized = JSON.stringify(snapshot);
    const sizeBytes = new TextEncoder().encode(serialized).byteLength;
    if (sizeBytes !== Number(session.snapshot_size_bytes) || (await sha256Hex(serialized)) !== session.snapshot_sha256) {
      throw new ApiError(502, "drive_session_integrity_mismatch");
    }
  }
  return json({
    ok: true,
    session: {
      ...session,
      storage: drivePointerId(session.snapshot_json) ? "google_drive" : "legacy_d1",
      snapshot,
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
    "SELECT session_id, name, snapshot_json FROM architect_sessions WHERE session_id = ?"
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
  const snapshotPayloadId = drivePointerId(existing.snapshot_json);
  if (snapshotPayloadId) await deletePayloadBestEffort(env, snapshotPayloadId);
  return json({ ok: true, deleted_session_id: sessionId });
}

async function architectStorageUsage(request, env) {
  await authenticateArchitect(request, env);
  await Promise.all([backfillLegacyReports(env), ensureSessionStorage(env), ensurePayloadStorage(env)]);
  const usage = await env.DB.prepare(
    "SELECT " +
    "(SELECT COUNT(*) FROM agent_reports) AS report_count, " +
    "(SELECT COALESCE(SUM(report_size_bytes), 0) FROM agent_reports) AS report_payload_bytes, " +
    "(SELECT COUNT(*) FROM architect_sessions) AS session_count, " +
    "(SELECT COALESCE(SUM(snapshot_size_bytes), 0) FROM architect_sessions) AS session_payload_bytes, " +
    "(SELECT COUNT(*) FROM payload_objects) AS payload_object_count, " +
    "(SELECT COALESCE(SUM(size_bytes), 0) FROM payload_objects) AS drive_payload_bytes, " +
    "(SELECT COUNT(*) FROM interactive_threads) AS interactive_thread_count, " +
    "(SELECT COUNT(*) FROM interactive_messages) AS interactive_message_count"
  ).first();
  return json({
    ok: true,
    usage: {
      report_count: usage?.report_count || 0,
      report_payload_bytes: usage?.report_payload_bytes || 0,
      session_count: usage?.session_count || 0,
      session_payload_bytes: usage?.session_payload_bytes || 0,
      payload_object_count: usage?.payload_object_count || 0,
      drive_payload_bytes: usage?.drive_payload_bytes || 0,
      interactive_thread_count: usage?.interactive_thread_count || 0,
      interactive_message_count: usage?.interactive_message_count || 0,
      payload_provider: "google_drive",
      payload_configured: googleDrivePayloadConfig(env).configured,
      safe_d1_target_bytes: 400 * 1024 * 1024,
      d1_database_limit_bytes: 500 * 1024 * 1024,
      max_report_bytes: MAX_REPORT_BYTES
    }
  });
}

function parseControllerTimestamp(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(raw)
    ? raw
    : raw.replace(" ", "T") + "Z";
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTestNodeRecord(node) {
  const identity = `${node?.hostname || ""} ${node?.node_id || ""}`;
  return /(^|[^a-z0-9])(test|demo)([^a-z0-9]|$)/i.test(identity);
}

function operationalNodeState(node, now = Date.now()) {
  if (!node || node.status === "revoked") return "revoked";
  if (isTestNodeRecord(node)) return "test";
  const seenAt = parseControllerTimestamp(node.last_seen_at);
  if (seenAt === null) return "stale";
  const ageMinutes = Math.max(0, (now - seenAt) / 60000);
  if (ageMinutes >= NODE_ARCHIVE_AFTER_MINUTES) return "archived";
  if (ageMinutes >= NODE_STALE_AFTER_MINUTES) return "stale";
  if (node.status === "paused") return "paused";
  if (node.status === "online" && ageMinutes <= NODE_LIVE_WINDOW_MINUTES) return "live";
  return "offline";
}

export async function expireStaleCommands(env, nodeId = null) {
  const maxRows = arguments.length > 2 ? arguments[2] : 250;
  await ensureNodeAiStorage(env);
  const cutoff = new Date(Date.now() - COMMAND_MAX_AGE_SECONDS * 1000).toISOString();
  const stale = nodeId
    ? await env.DB.prepare(`
        SELECT command_id, node_id, command_type, status, created_at
        FROM commands
        WHERE node_id = ?
          AND status IN ('pending', 'accepted')
          AND datetime(created_at) < datetime(?)
          AND NOT (status = 'accepted'
            AND (command_type LIKE 'lmstudio_%' OR command_type = 'hybrid_query')
            AND datetime(created_at) >= datetime('now', '-2 hours')
            AND EXISTS (SELECT 1 FROM node_ai_runtime_state AS runtime
              WHERE runtime.node_id = commands.node_id
                AND json_extract(runtime.state_json, '$.operation_id') = commands.command_id
                AND datetime(runtime.updated_at) >= datetime('now', '-2 minutes')))
        ORDER BY created_at ASC
        LIMIT 50
      `).bind(nodeId, cutoff).all()
    : await env.DB.prepare(`
        SELECT command_id, node_id, command_type, status, created_at
        FROM commands
        WHERE status IN ('pending', 'accepted')
          AND datetime(created_at) < datetime(?)
          AND NOT (status = 'accepted'
            AND (command_type LIKE 'lmstudio_%' OR command_type = 'hybrid_query')
            AND datetime(created_at) >= datetime('now', '-2 hours')
            AND EXISTS (SELECT 1 FROM node_ai_runtime_state AS runtime
              WHERE runtime.node_id = commands.node_id
                AND json_extract(runtime.state_json, '$.operation_id') = commands.command_id
                AND datetime(runtime.updated_at) >= datetime('now', '-2 minutes')))
        ORDER BY created_at ASC
        LIMIT 250
      `).bind(cutoff).all();

  const commandLimit = Math.max(1, Math.min(nodeId ? 50 : 250, Number(maxRows) || (nodeId ? 50 : 250)));
  const rows = (stale.results || []).slice(0, commandLimit);
  for (const row of rows) {
    const update = await env.DB.prepare(`
      UPDATE commands
      SET status = 'failed', completed_at = CURRENT_TIMESTAMP
      WHERE command_id = ?
        AND status IN ('pending', 'accepted')
        AND datetime(created_at) < datetime(?)
          AND NOT (status = 'accepted'
            AND (command_type LIKE 'lmstudio_%' OR command_type = 'hybrid_query')
            AND datetime(created_at) >= datetime('now', '-2 hours')
            AND EXISTS (SELECT 1 FROM node_ai_runtime_state AS runtime
              WHERE runtime.node_id = commands.node_id
                AND json_extract(runtime.state_json, '$.operation_id') = commands.command_id
                AND datetime(runtime.updated_at) >= datetime('now', '-2 minutes')))
    `).bind(row.command_id, cutoff).run();
    if ((update?.meta?.changes || 0) === 1) {
      await env.DB.prepare(`
        INSERT INTO audit_events (
          actor_type, actor_id, action, target_type, target_id, details_json
        ) VALUES ('controller', 'controller', 'command.expired', 'command', ?, ?)
      `).bind(
        row.command_id,
        JSON.stringify({
          node_id: row.node_id,
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

async function expireStaleNodeCommands(env, nodeId) {
  return expireStaleCommands(env, nodeId);
}

async function recoverExpiredDiagnosticPause(env, node) {
  if (node.status !== 'paused' || Date.now() >= Date.parse(DIAGNOSTIC_RECOVERY_END) ||
      await sha256Hex(node.node_id) !== DIAGNOSTIC_NODE_HASH) return;
  await expireStaleNodeCommands(env, node.node_id);
  const latest = await env.DB.prepare(`SELECT c.*,
    EXISTS (SELECT 1 FROM audit_events a WHERE a.target_id=c.command_id AND a.action='command.queued'
      AND a.actor_type='controller' AND a.actor_id='diagnostic-pause-20261008') AS owned_resume,
    EXISTS (SELECT 1 FROM audit_events a WHERE a.target_id=c.command_id AND a.action='command.expired'
      AND json_extract(a.details_json,'$.previous_status')='pending'
      AND json_extract(a.details_json,'$.created_at')=c.created_at) AS expired_pending
    FROM commands c WHERE c.node_id=? ORDER BY datetime(c.created_at) DESC,c.rowid DESC LIMIT 1`).bind(node.node_id).first();
  if (!expiredDiagnosticResumeEligible(node, latest)) return;
  const pause = await env.DB.prepare(`SELECT command_id FROM commands WHERE node_id=? AND command_type='pause'
    ORDER BY datetime(created_at) DESC,rowid DESC LIMIT 1`).bind(node.node_id).first();
  if (!pause || latest.command_id !== 'command_diagnostic_resume_' + (await sha256Hex(pause.command_id)).slice(0,24)) return;
  const createdAt = new Date().toISOString();
  const signature = await signControllerCommand(env, latest.command_id, node.node_id, 'resume', '{}', createdAt);
  await env.DB.batch([
    env.DB.prepare(DIAGNOSTIC_RESUME_REQUEUE_SQL).bind(signature,createdAt,latest.command_id,node.node_id,
      latest.created_at,createdAt,pause.command_id),
    env.DB.prepare(`INSERT INTO audit_events(actor_type,actor_id,action,target_type,target_id,details_json)
      SELECT 'controller','diagnostic-pause-20261008','command.requeued','command',?,
        '{"command_type":"resume","reason":"end_diagnostic_pause_after_offline"}' WHERE changes()=1`).bind(latest.command_id)
  ]);
}

async function listCommands(request, env, nodeId, url) {
  const node = await authenticateNode(request, env, nodeId, url, new Uint8Array(0));
  return json(await commandsForNode(env, node));
}

async function commandsForNode(env, node) {
  const nodeId = node.node_id;
  await recoverExpiredDiagnosticPause(env, node);
  // Current-version nodes cannot benefit from rollout discovery. Skipping the
  // lookup removes one D1 read from every steady-state command poll.
  if (node.agent_version !== LATEST_NODE_RELEASE.version) {
    await ensureRolloutCommandForNode(env, nodeId);
    await repairPendingUpdateForNode(env, node);
    await continueCompletedBridgeUpdateForNode(env, node);
    await retryFailedBridgeUpdateForNode(env, node);
  }

  const cutoff = new Date(Date.now() - COMMAND_MAX_AGE_SECONDS * 1000).toISOString();
  const query = await env.DB.prepare(`
    SELECT command_id, command_type, payload_json, signature, status, created_at
    FROM commands
    WHERE node_id = ?
      AND status IN ('pending', 'accepted')
      AND datetime(created_at) >= datetime(?)
    ORDER BY created_at ASC
    LIMIT 20
  `).bind(nodeId, cutoff).all();

  const commands = (query.results || []).map((row) => ({
    ...row,
    payload: safeJson(row.payload_json, {}),
    payload_json: undefined
  }));
  return { ok: true, node_status: node.status, commands };
}

async function acknowledgeCommand(request, env, nodeId, commandId, url) {
  const { bytes: bodyBytes, text: bodyText } = await readBody(request, 128 * 1024);
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
    (current.status === "pending" && ["accepted", "completed", "failed", "cancelled"].includes(status)) ||
    (current.status === "accepted" && ["completed", "failed", "cancelled"].includes(status));
  if (!transitionAllowed) {
    throw new ApiError(409, "invalid_command_transition");
  }

  let commandResult = null;
  if (body.result !== undefined) {
    if (current.command_type !== "ssh_console" || !["completed", "failed"].includes(status)) {
      throw new ApiError(400, "command_result_not_allowed");
    }
    commandResult = normalizeSshConsoleResult(body.result);
  } else if (current.command_type === "ssh_console" && status === "completed") {
    throw new ApiError(400, "ssh_console_result_required");
  }
  const detailsJson = JSON.stringify({
    status,
    result_bytes: commandResult ? new TextEncoder().encode(commandResult.output).length : 0
  });
  const statements = [
    env.DB.prepare(`
      UPDATE commands
      SET status = ?,
          completed_at = CASE
            WHEN ? IN ('completed', 'failed', 'cancelled') THEN CURRENT_TIMESTAMP
            ELSE completed_at
          END
      WHERE command_id = ?
        AND node_id = ?
        AND status = ?
    `).bind(status, status, commandId, nodeId, current.status)
  ];

  if (commandResult) {
    statements.push(env.DB.prepare(`
      INSERT INTO ssh_console_results (
        command_id, node_id, output, exit_code, created_at
      )
      SELECT ?, ?, ?, ?, CURRENT_TIMESTAMP
      WHERE changes() = 1
      ON CONFLICT(command_id) DO UPDATE SET
        output = excluded.output,
        exit_code = excluded.exit_code,
        created_at = CURRENT_TIMESTAMP
    `).bind(commandId, nodeId, commandResult.output, commandResult.exit_code));
  }

  statements.push(env.DB.prepare(`
    INSERT INTO audit_events (
      actor_type, actor_id, action, target_type, target_id, details_json
    )
    SELECT 'node', ?, 'command.acknowledged', 'command', ?, ?
    WHERE changes() = 1
  `).bind(nodeId, commandId, detailsJson));

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
    } else if (current.command_type === "lmstudio_uninstall") {
      statements.push(env.DB.prepare(`
        INSERT INTO node_ai_state (
          node_id, installed, selected_model, loaded_model, server_running, last_action, updated_at
        ) VALUES (?, 0, NULL, NULL, 0, 'uninstalled', CURRENT_TIMESTAMP)
        ON CONFLICT(node_id) DO UPDATE SET
          installed = 0, selected_model = NULL, loaded_model = NULL,
          server_running = 0, last_action = 'uninstalled', updated_at = CURRENT_TIMESTAMP
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
  await recordOperationalReport(env, nodeId, "command_" + status,
    {command_id: commandId, command_type: current.command_type, status, result: commandResult});

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

function d1ServiceErrorCode(error, scope = "controller") {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("daily row read limit")) return `${scope}_d1_daily_read_limit_exceeded`;
  if (message.includes("daily row write limit")) return `${scope}_d1_daily_write_limit_exceeded`;
  if (message.includes("exceeded maximum db size")) return `${scope}_d1_database_size_exceeded`;
  if (message.includes("overloaded") || message.includes("too many api requests")) {
    return `${scope}_d1_overloaded`;
  }
  if (message.includes("d1") || message.includes("sqlite")) return `${scope}_d1_error`;
  return null;
}

function throwScopedD1Error(error, scope = "controller") {
  const code = d1ServiceErrorCode(error, scope);
  if (code) throw new ApiError(503, code);
  throw error;
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
        CREATE TABLE IF NOT EXISTS node_group_categories (
          group_id TEXT PRIMARY KEY,
          category TEXT NOT NULL CHECK (category IN ('name','geography','work','specialty','other')),
          FOREIGN KEY (group_id) REFERENCES enterprise_node_groups(group_id) ON DELETE CASCADE
        )
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

async function readArchitectAuthState(env) {
  return env.DB.prepare(`
    SELECT token_hash, bootstrap_mode, recovery_hash, recovery_used,
      token_rotated_at, recovery_created_at, updated_at
    FROM architect_auth_state WHERE singleton_id = 1
  `).first();
}

function architectAuthStorageMissing(error) {
  return /no such table:\s*architect_auth_state/i.test(String(error?.message || error || ""));
}

async function architectAuthState(env) {
  let row;
  try {
    row = await readArchitectAuthState(env);
  } catch (error) {
    if (!architectAuthStorageMissing(error)) throwScopedD1Error(error, "architect");
    try {
      await ensureArchitectAuthStorage(env);
      row = await readArchitectAuthState(env);
    } catch (bootstrapError) {
      throwScopedD1Error(bootstrapError, "architect");
    }
  }

  if (!row) {
    try {
      await ensureArchitectAuthStorage(env);
      row = await readArchitectAuthState(env);
    } catch (bootstrapError) {
      throwScopedD1Error(bootstrapError, "architect");
    }
  }

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
  let actor = null;
  if (constantTimeHexEqual(actualHash, String(state.token_hash).toLowerCase())) {
    actor = { actor_id: "primary", role: "owner", token_id: null };
  } else {
    let delegated = null;
    try {
      delegated = await env.DB.prepare(`
        SELECT token_id, role
        FROM architect_access_tokens
        WHERE token_hash = ? AND enabled = 1 AND revoked_at IS NULL
        LIMIT 1
      `).bind(actualHash).first();
    } catch (error) {
      const message = String(error?.message || error || "");
      if (!/no such table:\s*architect_access_tokens/i.test(message)) {
        throwScopedD1Error(error, "architect");
      }
    }
    if (!delegated || !ARCHITECT_ROLE_PERMISSIONS[delegated.role]) {
      throw new ApiError(401, "invalid_architect_token");
    }
    actor = {
      actor_id: String(delegated.token_id),
      token_id: String(delegated.token_id),
      role: String(delegated.role)
    };
    await env.DB.prepare(`
      UPDATE architect_access_tokens
      SET last_used_at = CURRENT_TIMESTAMP
      WHERE token_id = ?
        AND (last_used_at IS NULL OR last_used_at < datetime('now', '-5 minutes'))
    `).bind(actor.token_id).run();
  }

  const pathname = new URL(request.url).pathname;
  const required = requiredArchitectPermission(request.method, pathname);
  if (!roleHasPermission(actor.role, required)) {
    throw new ApiError(403, "architect_permission_denied");
  }
  return actor;
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
  const actor = await authenticateArchitect(request, env);
  const state = await architectAuthState(env);
  return json({
    ok: true,
    security: {
      actor_role: actor.role,
      available_roles: Object.keys(ARCHITECT_ROLE_PERMISSIONS),
      recovery_configured: Boolean(state.recovery_hash) && Number(state.recovery_used || 0) === 0,
      bootstrap_mode: Number(state.bootstrap_mode || 0) === 1,
      token_rotated_at: state.token_rotated_at || null,
      recovery_created_at: state.recovery_created_at || null
    }
  });
}

async function architectListAccessTokens(request, env) {
  await authenticateArchitect(request, env);
  await ensureEnterpriseStorage(env);
  const query = await env.DB.prepare(`
    SELECT token_id, label, role, enabled, created_at, last_used_at, revoked_at
    FROM architect_access_tokens
    ORDER BY created_at DESC
    LIMIT 100
  `).all();
  return json({ ok: true, access_tokens: query.results || [] });
}

async function architectCreateAccessToken(request, env) {
  await authenticateArchitect(request, env);
  await ensureEnterpriseStorage(env);
  const body = parseJsonObject(await readBodyText(request, 4096));
  const role = requireString(body.role, "role", 32);
  if (!["viewer", "operator"].includes(role)) {
    throw new ApiError(400, "invalid_role");
  }
  const label = requireString(body.label, "label", 120);
  const token = randomArchitectSecret("citadel_role_");
  const tokenHash = await sha256Hex(token);
  const tokenId = `archtok_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO architect_access_tokens (
        token_id, token_hash, role, label, enabled
      ) VALUES (?, ?, ?, ?, 1)
    `).bind(tokenId, tokenHash, role, label),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      ) VALUES ('architect', 'primary', 'architect.access_token.created',
        'architect_access_token', ?, ?)
    `).bind(tokenId, JSON.stringify({ role, label }))
  ]);
  return json({
    ok: true,
    access_token: {
      token_id: tokenId,
      label,
      role,
      token,
      display_once: true
    }
  }, 201);
}

async function architectRevokeAccessToken(request, env, tokenId) {
  await authenticateArchitect(request, env);
  await ensureEnterpriseStorage(env);
  const result = await env.DB.prepare(`
    UPDATE architect_access_tokens
    SET enabled = 0, revoked_at = CURRENT_TIMESTAMP
    WHERE token_id = ? AND enabled = 1
  `).bind(tokenId).run();
  if ((result.meta?.changes || 0) !== 1) {
    throw new ApiError(404, "access_token_not_found");
  }
  await env.DB.prepare(`
    INSERT INTO audit_events (
      actor_type, actor_id, action, target_type, target_id, details_json
    ) VALUES ('architect', 'primary', 'architect.access_token.revoked',
      'architect_access_token', ?, '{}')
  `).bind(tokenId).run();
  return json({ ok: true, revoked: true, token_id: tokenId });
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

async function getEnterprisePolicy(env) {
  await ensureEnterpriseStorage(env);
  const row = await env.DB.prepare(`
    SELECT policy_json, updated_at
    FROM enterprise_desired_state
    WHERE singleton_id = 1
  `).first();
  return {
    policy: normalizeEnterprisePolicy(safeJson(row?.policy_json, DEFAULT_ENTERPRISE_POLICY)),
    updated_at: row?.updated_at || null
  };
}

async function architectEnterpriseOverview(request, env) {
  const actor = await authenticateArchitect(request, env);
  await Promise.all([
    ensureEnterpriseStorage(env),
    backfillLegacyReports(env)
  ]);

  const [policyState, sitesQuery, groupsQuery, scopesQuery, nodesQuery, reportsQuery, integrityCounts] =
    await Promise.all([
      getEnterprisePolicy(env),
      env.DB.prepare(`
        SELECT site_id, name, description, created_at, updated_at
        FROM enterprise_sites ORDER BY name ASC
      `).all(),
      env.DB.prepare(`
        SELECT group_id, name, description, created_at, updated_at
        FROM enterprise_node_groups ORDER BY name ASC
      `).all(),
      env.DB.prepare(`
        SELECT s.node_id, s.site_id, es.name AS site_name,
          s.group_id, eg.name AS group_name, s.updated_at
        FROM enterprise_node_scope AS s
        LEFT JOIN enterprise_sites AS es ON es.site_id = s.site_id
        LEFT JOIN enterprise_node_groups AS eg ON eg.group_id = s.group_id
      `).all(),
      env.DB.prepare(`
        SELECT node_id, hostname, os_name, os_version, architecture,
          agent_version, status, capabilities_json, cpu_percent, memory_percent,
          enrolled_at, last_seen_at
        FROM nodes
        WHERE status != 'revoked'
        ORDER BY last_seen_at DESC
        LIMIT 500
      `).all(),
      env.DB.prepare(`
        SELECT node_id, report_id, report_json, report_sha256,
          report_size_bytes, created_at
        FROM agent_reports
        WHERE report_type = 'system_inventory'
        ORDER BY created_at DESC, report_id DESC
        LIMIT 1000
      `).all(),
      env.DB.prepare(`
        SELECT
          COUNT(*) AS total_reports,
          SUM(CASE WHEN report_sha256 IS NOT NULL
            AND length(report_sha256) = 64
            AND report_size_bytes IS NOT NULL
            AND report_size_bytes >= 0 THEN 1 ELSE 0 END) AS reports_with_integrity_metadata
        FROM agent_reports
      `).first()
    ]);

  const scopes = new Map((scopesQuery.results || []).map((row) => [row.node_id, row]));
  const latestInventory = new Map();
  for (const row of reportsQuery.results || []) {
    if (!latestInventory.has(row.node_id)) latestInventory.set(row.node_id, row);
  }

  const nodes = [];
  let compliant = 0;
  let complianceInScope = 0;
  let excludedFromCompliance = 0;
  let enterpriseProbeReady = 0;
  let verifiedLatestInventories = 0;
  for (const node of nodesQuery.results || []) {
    const report = latestInventory.get(node.node_id);
    const inventory = report ? safeJson(report.report_json, null) : null;
    let inventoryIntegrity = null;
    if (report?.report_json && report?.report_sha256) {
      const digest = await sha256Hex(report.report_json);
      inventoryIntegrity = constantTimeHexEqual(
        digest,
        String(report.report_sha256).toLowerCase()
      );
      if (inventoryIntegrity) verifiedLatestInventories += 1;
    }
    const operationalState = operationalNodeState(node);
    const inComplianceScope = !["test", "stale", "archived"].includes(operationalState);
    const compliance = evaluateEnterpriseNode(
      node,
      inventory,
      policyState.policy,
      LATEST_NODE_RELEASE.version
    );
    if (inComplianceScope) {
      complianceInScope += 1;
      if (compliance.compliant) compliant += 1;
    } else {
      excludedFromCompliance += 1;
    }
    if (compliance.windows_enterprise?.available === true) enterpriseProbeReady += 1;
    const scope = scopes.get(node.node_id) || {};
    nodes.push({
      ...node,
      capabilities: safeJson(node.capabilities_json, []),
      capabilities_json: undefined,
      site_id: scope.site_id || null,
      site_name: scope.site_name || null,
      group_id: scope.group_id || null,
      group_name: scope.group_name || null,
      latest_inventory_at: report?.created_at || null,
      latest_inventory_integrity: inventoryIntegrity,
      operational_state: operationalState,
      compliance_in_scope: inComplianceScope,
      compliance
    });
  }

  return json({
    ok: true,
    actor_role: actor.role,
    service_catalog: {
      windows_service: "enabled",
      dpapi_identity: "enabled",
      event_log: "read_only_probe",
      cim_performance_counters: "read_only_probe",
      gmsa_dmsa: "readiness_and_identity_detection",
      windows_update_hotpatch: "read_only_state",
      hyper_v: "read_only_adapter",
      gpo_intune_mdm: "read_only_detection",
      rbac: "enabled",
      desired_state_policy: "enabled",
      sites_node_groups: "enabled",
      storage_integrity: "sha256_verified",
      recovery_manifest: "enabled"
    },
    policy: policyState.policy,
    policy_updated_at: policyState.updated_at,
    sites: sitesQuery.results || [],
    groups: groupsQuery.results || [],
    counts: {
      nodes: nodes.length,
      active_nodes: complianceInScope,
      excluded_nodes: excludedFromCompliance,
      compliant_nodes: compliant,
      noncompliant_nodes: Math.max(0, complianceInScope - compliant),
      windows_enterprise_probe_ready: enterpriseProbeReady
    },
    storage_integrity: {
      total_reports: Number(integrityCounts?.total_reports || 0),
      reports_with_integrity_metadata: Number(integrityCounts?.reports_with_integrity_metadata || 0),
      verified_latest_system_inventories: verifiedLatestInventories
    },
    nodes
  });
}

async function architectSetEnterprisePolicy(request, env) {
  await authenticateArchitect(request, env);
  await ensureEnterpriseStorage(env);
  const body = parseJsonObject(await readBodyText(request, 8192));
  const policy = normalizeEnterprisePolicy(body.policy || body);
  const policyJson = JSON.stringify(policy);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO enterprise_desired_state (singleton_id, policy_json, updated_at)
      VALUES (1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(singleton_id) DO UPDATE SET
        policy_json = excluded.policy_json,
        updated_at = CURRENT_TIMESTAMP
    `).bind(policyJson),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      ) VALUES ('architect', 'primary', 'enterprise.policy.updated',
        'enterprise_policy', 'singleton', ?)
    `).bind(policyJson)
  ]);
  return json({ ok: true, policy });
}

async function architectCreateEnterpriseSite(request, env) {
  await authenticateArchitect(request, env);
  await ensureEnterpriseStorage(env);
  const body = parseJsonObject(await readBodyText(request, 4096));
  const name = requireString(body.name, "site_name", 120);
  const description = optionalString(body.description, "site_description", 500) || "";
  const siteId = `site_${crypto.randomUUID()}`;
  try {
    await env.DB.prepare(`
      INSERT INTO enterprise_sites (site_id, name, description)
      VALUES (?, ?, ?)
    `).bind(siteId, name, description).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      throw new ApiError(409, "site_name_exists");
    }
    throw error;
  }
  return json({ ok: true, site: { site_id: siteId, name, description } }, 201);
}

async function architectCreateEnterpriseGroup(request, env) {
  await authenticateArchitect(request, env);
  await ensureEnterpriseStorage(env);
  const body = parseJsonObject(await readBodyText(request, 4096));
  const name = requireString(body.name, "group_name", 120);
  const description = optionalString(body.description, "group_description", 500) || "";
  const groupId = `group_${crypto.randomUUID()}`;
  try {
    await env.DB.prepare(`
      INSERT INTO enterprise_node_groups (group_id, name, description)
      VALUES (?, ?, ?)
    `).bind(groupId, name, description).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      throw new ApiError(409, "group_name_exists");
    }
    throw error;
  }
  return json({ ok: true, group: { group_id: groupId, name, description } }, 201);
}

async function architectCreateNodeGroup(request, env) {
  const actor = await authenticateArchitect(request, env);
  await ensureEnterpriseStorage(env);
  const body = parseJsonObject(await readBodyText(request, 16 * 1024));
  const name = requireString(body.name, "group_name", 120);
  const category = requireString(body.category, "group_category", 32);
  if (!["name", "geography", "work", "specialty", "other"].includes(category)) {
    throw new ApiError(400, "invalid_group_category");
  }
  if (!Array.isArray(body.node_ids) || !body.node_ids.length || body.node_ids.length > 50) {
    throw new ApiError(400, "invalid_group_nodes");
  }
  const nodeIds = [...new Set(body.node_ids.map((id) => requireString(id, "node_id", 128)))];
  const placeholders = nodeIds.map(() => "?").join(",");
  const nodes = await env.DB.prepare(
    `SELECT node_id FROM nodes WHERE node_id IN (${placeholders}) AND status != 'revoked'`
  ).bind(...nodeIds).all();
  if (nodes.results.length !== nodeIds.length) throw new ApiError(404, "node_not_found");
  const groupId = `group_${crypto.randomUUID()}`;
  try {
    // One D1 transaction creates the group and moves its members together.
    // Existing geography/site assignments remain intact.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO enterprise_node_groups (group_id, name) VALUES (?, ?)").bind(groupId, name),
      env.DB.prepare("INSERT INTO node_group_categories (group_id, category) VALUES (?, ?)").bind(groupId, category),
      ...nodeIds.map((id) => env.DB.prepare(`
        INSERT INTO enterprise_node_scope (node_id, group_id) VALUES (?, ?)
        ON CONFLICT(node_id) DO UPDATE SET group_id = excluded.group_id, updated_at = CURRENT_TIMESTAMP
      `).bind(id, groupId)),
      env.DB.prepare(`INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json)
        VALUES ('architect', ?, 'node_group.created', 'node_group', ?, ?)`)
        .bind(actor.actor_id, groupId, JSON.stringify({ name, category, node_ids: nodeIds }))
    ]);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new ApiError(409, "group_name_exists");
    throw error;
  }
  return json({ ok: true, group: { group_id: groupId, name, category }, node_ids: nodeIds }, 201);
}

async function architectDeleteNode(request, env, nodeId) {
  const actor = await authenticateArchitect(request, env);
  const body = parseJsonObject(await readBodyText(request, 1024));
  if (body.confirmation !== "DELETE_NODE") throw new ApiError(400, "node_delete_confirmation_required");
  await Promise.all([ensureCommandStorage(env), ensureProjectStorage(env)]);
  await expireStaleNodeCommands(env, nodeId);
  const node = await env.DB.prepare("SELECT node_id, hostname, status FROM nodes WHERE node_id = ?").bind(nodeId).first();
  if (!node) throw new ApiError(404, "node_not_found");
  if (node.status === "revoked") return json({ ok: true, deleted_node_id: nodeId });
  // A tombstone preserves reports and denies future agent authentication.
  // Keep the activity check inside the write so a busy node cannot be removed.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE nodes SET status = 'revoked'
      WHERE node_id = ? AND status != 'revoked'
      AND NOT EXISTS (SELECT 1 FROM commands WHERE node_id = nodes.node_id AND status IN ('pending','accepted'))
      AND NOT EXISTS (SELECT 1 FROM assignments WHERE node_id = nodes.node_id AND status IN ('assigned','running'))
      AND NOT EXISTS (SELECT 1 FROM project_work_items WHERE node_id = nodes.node_id AND status IN ('planned','assigned','running'))`)
      .bind(nodeId),
    env.DB.prepare(`INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json)
      SELECT 'architect', ?, 'node.deleted', 'node', node_id, ? FROM nodes WHERE node_id = ? AND status = 'revoked'`)
      .bind(actor.actor_id, JSON.stringify({ hostname: node.hostname }), nodeId)
  ]);
  if (!results[0].meta.changes) throw new ApiError(409, "node_busy");
  return json({ ok: true, deleted_node_id: nodeId });
}

async function architectSetNodeEnterpriseScope(request, env, nodeId) {
  await authenticateArchitect(request, env);
  await ensureEnterpriseStorage(env);
  const node = await env.DB.prepare(
    "SELECT node_id FROM nodes WHERE node_id = ? AND status != 'revoked'"
  ).bind(nodeId).first();
  if (!node) throw new ApiError(404, "node_not_found");

  const body = parseJsonObject(await readBodyText(request, 4096));
  const siteId = optionalString(body.site_id, "site_id", 128);
  const groupId = optionalString(body.group_id, "group_id", 128);
  if (siteId) {
    const site = await env.DB.prepare(
      "SELECT site_id FROM enterprise_sites WHERE site_id = ?"
    ).bind(siteId).first();
    if (!site) throw new ApiError(400, "invalid_site_id");
  }
  if (groupId) {
    const group = await env.DB.prepare(
      "SELECT group_id FROM enterprise_node_groups WHERE group_id = ?"
    ).bind(groupId).first();
    if (!group) throw new ApiError(400, "invalid_group_id");
  }

  await env.DB.prepare(`
    INSERT INTO enterprise_node_scope (node_id, site_id, group_id, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(node_id) DO UPDATE SET
      site_id = excluded.site_id,
      group_id = excluded.group_id,
      updated_at = CURRENT_TIMESTAMP
  `).bind(nodeId, siteId, groupId).run();
  return json({ ok: true, node_id: nodeId, site_id: siteId, group_id: groupId });
}

async function architectEnterpriseRecoveryManifest(request, env) {
  await authenticateArchitect(request, env);
  await Promise.all([ensureEnterpriseStorage(env), backfillLegacyReports(env)]);
  const [policyState, sites, groups, scopes, reports] = await Promise.all([
    getEnterprisePolicy(env),
    env.DB.prepare("SELECT site_id, name, description, updated_at FROM enterprise_sites ORDER BY name").all(),
    env.DB.prepare("SELECT group_id, name, description, updated_at FROM enterprise_node_groups ORDER BY name").all(),
    env.DB.prepare("SELECT node_id, site_id, group_id, updated_at FROM enterprise_node_scope ORDER BY node_id").all(),
    env.DB.prepare(`
      SELECT report_id, result_id, assignment_id, mission_id, node_id,
        report_type, report_sha256, report_size_bytes, sensitivity, created_at
      FROM agent_reports
      ORDER BY created_at DESC, report_id DESC
      LIMIT 5000
    `).all()
  ]);
  const manifest = {
    schema: "citadel.enterprise.recovery-manifest.v1",
    generated_at: new Date().toISOString(),
    policy: policyState.policy,
    sites: sites.results || [],
    groups: groups.results || [],
    node_scope: scopes.results || [],
    reports: reports.results || []
  };
  const manifestJson = JSON.stringify(manifest);
  return json({
    ok: true,
    manifest,
    manifest_sha256: await sha256Hex(manifestJson),
    note: "Manifest catalogs integrity metadata and topology; it does not expose report bodies or secrets."
  });
}

async function architectOverview(request, env) {
  await authenticateArchitect(request, env);
  await Promise.all([
    ensureSessionStorage(env),
    ensureAutoEnrollmentStorage(env),
    ensureProjectStorage(env),
    ensureNodeNetworkStorage(env),
    ensureNodeAiStorage(env),
    ensureCommandReadIndexes(env)
  ]);
  // Overview is a read path. Do not run command-retention housekeeping on every
  // browser refresh; write/control paths expire stale commands before they need
  // the active-command slot. Filter stale active rows in the read query instead.
  const activeCommandCutoff = new Date(Date.now() - COMMAND_MAX_AGE_SECONDS * 1000).toISOString();

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
      "n.agent_version, n.capabilities_json, CASE WHEN n.status = 'online' " +
      "AND (n.last_seen_at IS NULL OR datetime(n.last_seen_at) < datetime('now', '-5 minutes')) " +
      "THEN 'offline' ELSE n.status END AS status, n.cpu_percent, n.memory_percent, " +
      "n.enrolled_at, n.last_seen_at, net.lan_ipv4, net.mac_addresses_json, " +
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
      "SELECT c.command_id, c.node_id, c.command_type, c.status, c.created_at, c.completed_at, " +
      "CASE WHEN EXISTS (SELECT 1 FROM audit_events AS ae " +
      "WHERE ae.target_type = 'command' AND ae.target_id = c.command_id " +
      "AND ae.action = 'command.expired') THEN 1 ELSE 0 END AS ttl_expired " +
      "FROM commands AS c WHERE (c.status IN ('pending', 'accepted') " +
      "AND datetime(c.created_at) >= datetime(?)) " +
      "OR c.command_id IN (" +
      "SELECT command_id FROM commands WHERE status NOT IN ('pending', 'accepted') " +
      "ORDER BY created_at DESC LIMIT 50" +
      ") ORDER BY c.created_at DESC"
    ).bind(activeCommandCutoff).all()
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
  const liveRelays = rawNodes.filter((node) => wakeRelayEligible(node));
  const nodes = rawNodes.map((node) => {
    const macAddresses = safeJson(node.mac_addresses_json, []);
    const prefix = subnet24(node.lan_ipv4);
    const relay = prefix && Array.isArray(macAddresses) && macAddresses.length
      ? liveRelays.find((candidate) =>
          candidate.node_id !== node.node_id && subnet24(candidate.lan_ipv4) === prefix
        )
      : null;
    const operationalState = operationalNodeState(node);
    return {
      ...node,
      operational_state: operationalState,
      test_node: operationalState === "test",
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
      operational_nodes: nodes.filter((node) => ["live","offline","paused"].includes(node.operational_state)).length,
      stale_nodes: nodes.filter((node) => ["stale","archived"].includes(node.operational_state)).length,
      test_nodes: nodes.filter((node) => node.operational_state === "test").length,
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

function publicHubQueryErrorCode(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("daily row read limit")) return "hub_d1_daily_read_limit_exceeded";
  if (message.includes("daily row write limit")) return "hub_d1_daily_write_limit_exceeded";
  if (message.includes("exceeded maximum db size")) return "hub_d1_database_size_exceeded";
  if (message.includes("overloaded")) return "hub_d1_overloaded";
  if (message.includes("no such table") && message.includes("nodes")) return "hub_nodes_table_missing";
  if (message.includes("no such column")) return "hub_nodes_schema_mismatch";
  if (message.includes("d1")) return "hub_nodes_d1_error";
  return "hub_nodes_query_failed";
}


async function queryArchitectMachines(env) {
  const [nodes, commands, groups] = await Promise.all([
    env.DB.prepare(`SELECT n.node_id, nn.node_number, n.hostname, n.os_name, n.os_version, n.architecture,
      n.agent_version, n.cpu_percent, n.memory_percent, n.last_seen_at,
      CASE WHEN n.status = 'online' AND
      (n.last_seen_at IS NULL OR datetime(n.last_seen_at) < datetime('now', '-5 minutes'))
      THEN 'offline' ELSE n.status END AS status,
      net.lan_ipv4, net.mac_addresses_json,
      COALESCE(ai.installed, 0) AS ai_installed,
      COALESCE(ai.server_running, 0) AS ai_server_running,
      ai.selected_model AS ai_selected_model,
      ai.loaded_model AS ai_loaded_model,
      ai.updated_at AS ai_updated_at,
      air.state_json AS ai_runtime_json, scope.group_id
      FROM nodes AS n
      LEFT JOIN node_numbers AS nn ON nn.node_id = n.node_id
      LEFT JOIN node_network_state AS net ON net.node_id = n.node_id
      LEFT JOIN node_ai_state AS ai ON ai.node_id = n.node_id
      LEFT JOIN node_ai_runtime_state AS air ON air.node_id = n.node_id
      LEFT JOIN enterprise_node_scope AS scope ON scope.node_id = n.node_id
      WHERE n.status != 'revoked' ORDER BY n.node_id LIMIT 500`).all(),
    env.DB.prepare(`SELECT command_id, node_id, command_type, status, created_at, completed_at
      FROM commands
      WHERE status IN ('pending','accepted')
        OR datetime(created_at) >= datetime('now', '-30 minutes')
      ORDER BY created_at DESC LIMIT 500`).all(),
    env.DB.prepare(`SELECT g.group_id, g.name, COALESCE(c.category, 'other') AS category
      FROM enterprise_node_groups AS g
      LEFT JOIN node_group_categories AS c ON c.group_id = g.group_id
      ORDER BY g.name`).all()
  ]);
  return { nodes, commands, groups };
}

async function repairArchitectMachinesStorage(env, error) {
  const message = String(error?.message || error || "").toLowerCase();
  const repairs = [];
  if (/no such table:\s*(node_ai_state|node_ai_runtime_state)/i.test(message)) {
    repairs.push(ensureNodeAiStorage(env));
  }
  if (/no such table:\s*node_network_state/i.test(message)) {
    repairs.push(ensureNodeNetworkStorage(env));
  }
  if (/no such table:\s*(node_numbers|auto_enrollment_windows)/i.test(message)) {
    repairs.push(ensureAutoEnrollmentStorage(env));
  }
  if (/no such table:\s*(enterprise_node_scope|enterprise_node_groups|node_group_categories)/i.test(message)) {
    repairs.push(ensureEnterpriseStorage(env));
  }
  if (/no such table:\s*commands/i.test(message) || /no such column:\s*completed_at/i.test(message)) {
    repairs.push(ensureCommandStorage(env));
  }
  if (!repairs.length) return false;
  await Promise.all(repairs);
  return true;
}

async function readArchitectMachines(env) {
  try {
    return await queryArchitectMachines(env);
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!/no such (table|column):/i.test(message)) {
      throwScopedD1Error(error, "architect");
    }

    try {
      if (!await repairArchitectMachinesStorage(env, error)) {
        throw new ApiError(503, "architect_storage_schema_mismatch");
      }
      return await queryArchitectMachines(env);
    } catch (repairError) {
      if (repairError instanceof ApiError) throw repairError;
      const code = d1ServiceErrorCode(repairError, "architect");
      if (code) throw new ApiError(503, code);
      console.error("Architect machines storage repair failed", String(repairError));
      throw new ApiError(503, "architect_storage_unavailable");
    }
  }
}

async function publicHubNodes(env) {
  let query;
  try {
    query = await env.DB.prepare(
      "SELECT node_id, agent_version, status, enrolled_at, last_seen_at " +
      "FROM nodes WHERE status != 'revoked' LIMIT 500"
    ).all();
  } catch (error) {
    console.error("Public Hub nodes query failed", error);
    throw new ApiError(503, publicHubQueryErrorCode(error));
  }
  const rows = (query.results || []).sort((left, right) => {
    const a = String(left?.enrolled_at || "") + "\n" + String(left?.node_id || "");
    const b = String(right?.enrolled_at || "") + "\n" + String(right?.node_id || "");
    return a.localeCompare(b);
  });
  const liveCutoff = Date.now() - NODE_LIVE_WINDOW_MINUTES * 60 * 1000;
  return json({
    ok: true,
    refreshed_at: new Date().toISOString(),
    nodes: rows.map((node, index) => {
      const seenAt = parseControllerTimestamp(node.last_seen_at);
      const status = node.status === "online" && (seenAt === null || seenAt < liveCutoff)
        ? "offline" : typeof node.status === "string" ? node.status : "unknown";
      return {
        node_number: index + 1,
        display_name: `CITADEL Node ${index + 1}`,
        agent_version: typeof node.agent_version === "string" ? node.agent_version : null,
        status,
        enrolled_at: typeof node.enrolled_at === "string" ? node.enrolled_at : null,
        last_seen_at: typeof node.last_seen_at === "string" ? node.last_seen_at : null
      };
    })
  }, 200, {
    "cache-control": "public, max-age=60, stale-while-revalidate=120"
  });
}

async function architectRelease(request, env) {
  await authenticateArchitect(request, env);
  const quality = openRouterQualityConfig(env);
  return json({
    ok: true,
    release: LATEST_NODE_RELEASE,
    lmstudio: LMSTUDIO_INTEGRATION,
    openrouter: {
      configured: quality.configured,
      key_status: quality.keyStatus,
      model: quality.model,
      fusion_preset: quality.fusionPreset,
      timeout_ms: quality.timeoutMs
    }
  });
}


function terminalAiCommandStatus(commandType, runtime) {
  const phase = String(runtime?.progress_phase || "");
  const queryStatus = String(runtime?.query_status || "");
  if (phase === "cancelled") return "cancelled";
  if (phase === "failed") return "failed";
  if (commandType === "hybrid_query" && queryStatus === "cancelled") return "cancelled";
  if (commandType === "hybrid_query" && queryStatus === "failed") return "failed";
  if (commandType === "lmstudio_model_get" && phase === "download_complete") return "completed";
  if (commandType === "lmstudio_model_load" && phase === "load_complete") return "completed";
  if (
    ["lmstudio_install", "lmstudio_uninstall"].includes(commandType) &&
    ["complete", "completed", "completed_partial"].includes(phase)
  ) return "completed";
  if (
    commandType === "hybrid_query" &&
    (queryStatus === "completed" || phase === "query_complete")
  ) return "completed";
  return null;
}

async function reconcileTerminalAiCommand(env, nodeId, command) {
  if (!command || !["lmstudio_install", "lmstudio_uninstall", "lmstudio_model_get", "lmstudio_model_load", "hybrid_query"].includes(command.command_type)) {
    return false;
  }
  await ensureNodeAiStorage(env);
  const runtimeRow = await env.DB.prepare(
    "SELECT state_json FROM node_ai_runtime_state WHERE node_id = ?"
  ).bind(nodeId).first();
  const runtime = safeJson(runtimeRow?.state_json, {});
  const commandId = typeof runtime.operation_id === "string"
    ? runtime.operation_id.trim()
    : "";
  if (!commandId || commandId !== command.command_id) return false;

  const nextStatus = terminalAiCommandStatus(command.command_type, runtime);
  if (!nextStatus) return false;

  const update = await env.DB.prepare(
    "UPDATE commands SET status = ?, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) " +
    "WHERE command_id = ? AND node_id = ? AND status IN ('pending', 'accepted')"
  ).bind(nextStatus, commandId, nodeId).run();
  const changed = Number(update?.meta?.changes || 0) === 1;
  if (changed) {
    console.log("Recovered terminal AI command from runtime state", {
      node_id: nodeId,
      command_id: commandId,
      command_type: command.command_type,
      status: nextStatus
    });
  }
  return changed;
}

async function architectCreateCommand(request, env, nodeId) {
  const actor = await authenticateArchitect(request, env);
  const bodyText = await readBodyText(request, 8 * 1024);
  const body = parseJsonObject(bodyText);
  const commandType = requireString(body.command_type, "command_type", 32);
  // Bootstrap storage before any query touches the commands table. A partially
  // initialized D1 must be able to create its first LM Studio command directly.
  try {
    await ensureCommandStorage(env);
    if (commandType === "ssh_console") {
      await pruneExpiredSshConsoleResults(env);
    }
    await expireStaleNodeCommands(env, nodeId);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error("Command storage preflight failed", { node_id: nodeId, command_type: commandType, error: String(error) });
    throw new ApiError(503, commandType.startsWith("lmstudio_")
      ? "lmstudio_command_storage_unavailable"
      : "command_storage_unavailable");
  }
  if (!ALLOWED_ARCHITECT_COMMAND_TYPES.has(commandType)) {
    throw new ApiError(400, "command_type_not_allowed");
  }
  if (
    ["uninstall", "system_reboot", "system_shutdown", "lmstudio_uninstall"].includes(commandType) &&
    !roleHasPermission(actor.role, "admin")
  ) {
    throw new ApiError(403, "architect_admin_required");
  }
  const requiredConfirmation = COMMAND_CONFIRMATIONS[commandType];
  if (requiredConfirmation) {
    const confirmation = typeof body.confirmation === "string" ? body.confirmation.trim() : "";
    if (confirmation !== requiredConfirmation) {
      throw new ApiError(
        400,
        commandType === "lmstudio_uninstall"
          ? "command_confirmation_required"
          : "power_confirmation_required"
      );
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
  if ((commandType.startsWith("lmstudio_") || commandType === "hybrid_query") && !agentVersionAtLeast(node.agent_version, "0.3.19")) {
    throw new ApiError(409, "agent_update_required");
  }
  if (commandType === "ssh_console" && !agentVersionAtLeast(node.agent_version, "0.3.32")) {
    throw new ApiError(409, "agent_update_required");
  }
  if (commandType === "pause" && node.status === "paused") {
    throw new ApiError(409, "node_already_paused");
  }
  if (commandType === "resume" && node.status !== "paused") {
    throw new ApiError(409, "node_not_paused");
  }

  let pending = await env.DB.prepare(
    "SELECT command_id, command_type, status, payload_json FROM commands " +
    "WHERE node_id = ? AND status IN ('pending', 'accepted') LIMIT 1"
  ).bind(nodeId).first();
  if (pending && await reconcileTerminalAiCommand(env, nodeId, pending)) {
    pending = await env.DB.prepare(
      "SELECT command_id, command_type, status, payload_json FROM commands " +
      "WHERE node_id = ? AND status IN ('pending', 'accepted') LIMIT 1"
    ).bind(nodeId).first();
  }
  if (pending) {
    if (commandType !== "update" || pending.command_type !== "update" ||
        pending.status !== "pending" ||
        updatePayloadReadyForAgent(safeJson(pending.payload_json, {}), node.agent_version)) {
      throw new ApiError(409, "command_already_pending");
    }
    const retired = await env.DB.prepare(
      "UPDATE commands SET status = 'failed', completed_at = CURRENT_TIMESTAMP " +
      "WHERE command_id = ? AND status = 'pending'"
    ).bind(pending.command_id).run();
    if (Number(retired?.meta?.changes || 0) !== 1) {
      throw new ApiError(409, "command_already_pending");
    }
    await env.DB.prepare(
      "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
      "VALUES ('architect', ?, 'agent.update.incompatible_command_retired', 'command', ?, ?)"
    ).bind(actor.actor_id, pending.command_id, JSON.stringify({
      node_id: nodeId, agent_version: node.agent_version
    })).run();
  }

  const commandId = "command_" + crypto.randomUUID();
  let payload = {};
  if (commandType === "update") {
    payload = releaseForAgentVersion(LATEST_NODE_RELEASE, node.agent_version);
  } else if (commandType === "lmstudio_install") {
    payload = { asset: lmstudioInstallAssetForNode(node) };
  } else if (commandType === "lmstudio_uninstall") {
    payload = { purge_data: body.purge_data === true };
  } else if (commandType === "lmstudio_probe" || commandType === "ssh_probe") {
    payload = {};
  } else if (commandType === "ssh_console") {
    payload = { command: normalizeSshConsoleCommand(body.command) };
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
    const mode = requireString(body.mode, "hybrid_mode", 16);
    if (!["python","lmstudio","both"].includes(mode)) throw new ApiError(400, "invalid_hybrid_mode");
    if (mode !== "python") {
      await ensureNodeAiStorage(env);
      const ai = await nodeAiStateResponse(env, nodeId);
      if (Number(ai.installed || 0) !== 1 || Number(ai.server_running || 0) !== 1 || !ai.loaded_model) {
        throw new ApiError(409, "lmstudio_model_not_ready");
      }
    }
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

  let commandPersisted = false;
  try {
    await env.DB.prepare(
      "INSERT INTO commands (" +
      "command_id, node_id, command_type, payload_json, signature, status, created_at" +
      ") VALUES (?, ?, ?, ?, ?, 'pending', ?)"
    ).bind(commandId, nodeId, commandType, payloadJson, signature, createdAt).run();
    commandPersisted = true;
  } catch (error) {
    const message = String(error).toLowerCase();
    if (
      message.includes("idx_commands_one_active_per_node") ||
      message.includes("unique") ||
      message.includes("commands.node_id")
    ) {
      throw new ApiError(409, "command_already_pending");
    }
    try {
      commandPersisted = Boolean(await env.DB.prepare(
        "SELECT command_id FROM commands WHERE command_id = ?"
      ).bind(commandId).first());
    } catch {
      commandPersisted = false;
    }
    if (!commandPersisted) {
      console.error("Command persistence failed", {
        node_id: nodeId, command_type: commandType, error: String(error)
      });
      throw new ApiError(503, commandType.startsWith("lmstudio_")
        ? "lmstudio_command_storage_unavailable"
        : "command_storage_unavailable");
    }
  }

  try {
    await env.DB.prepare(
      "INSERT INTO audit_events (" +
      "actor_type, actor_id, action, target_type, target_id, details_json" +
      ") VALUES ('architect', ?, 'command.created', 'command', ?, ?)"
    ).bind(actor.actor_id, commandId, detailsJson).run();
  } catch (error) {
    console.error("Command audit persistence failed", {
      node_id: nodeId, command_id: commandId, command_type: commandType, error: String(error)
    });
  }

  return json({
    ok: true,
    command: {
      command_id: commandId,
      node_id: nodeId,
      command_type: commandType,
      query_id: payload.request_id || null,
      status: "pending",
      created_at: createdAt
    }
  }, 201);
}

async function architectCancelCommand(request, env, nodeId, commandId) {
  const actor = await authenticateArchitect(request, env);
  await ensureCommandStorage(env);
  const command = await env.DB.prepare(
    "SELECT command_id, node_id, command_type, status FROM commands WHERE command_id = ? AND node_id = ?"
  ).bind(commandId, nodeId).first();
  if (!command) throw new ApiError(404, "command_not_found");
  if (command.command_type !== "hybrid_query") {
    throw new ApiError(409, "command_not_cancellable");
  }
  if (["completed", "failed", "cancelled"].includes(command.status)) {
    return json({ ok: true, cancel: { command_id: commandId, requested: true, status: command.status } });
  }
  if (!["pending", "accepted"].includes(command.status)) {
    throw new ApiError(409, "command_not_cancellable");
  }

  const details = JSON.stringify({
    node_id: nodeId,
    command_type: command.command_type,
    previous_status: command.status
  });
  const statements = [];
  if (command.status === "pending") {
    statements.push(env.DB.prepare(
      "UPDATE commands SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP " +
      "WHERE command_id = ? AND node_id = ? AND status = 'pending'"
    ).bind(commandId, nodeId));
  }
  statements.push(env.DB.prepare(`
    INSERT INTO audit_events (
      actor_type, actor_id, action, target_type, target_id, details_json
    )
    SELECT 'architect', ?, 'command.cancel_requested', 'command', ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_events
      WHERE target_type = 'command' AND target_id = ? AND action = 'command.cancel_requested'
    )
  `).bind(actor.actor_id || "architect", commandId, details, commandId));
  await env.DB.batch(statements);
  return json({
    ok: true,
    cancel: {
      command_id: commandId,
      requested: true,
      status: command.status === "pending" ? "cancelled" : "accepted"
    }
  });
}

async function nodeCommandCancelState(request, env, nodeId, commandId, url) {
  await authenticateNode(request, env, nodeId, url, new Uint8Array(0));
  const row = await env.DB.prepare(`
    SELECT c.command_type, c.status,
      EXISTS(
        SELECT 1 FROM audit_events AS a
        WHERE a.target_type = 'command'
          AND a.target_id = c.command_id
          AND a.action = 'command.cancel_requested'
      ) AS cancel_requested
    FROM commands AS c
    WHERE c.command_id = ? AND c.node_id = ?
  `).bind(commandId, nodeId).first();
  if (!row) throw new ApiError(404, "command_not_found");
  return json({
    ok: true,
    command_id: commandId,
    cancel_requested: row.command_type === "hybrid_query" &&
      (row.status === "cancelled" || Number(row.cancel_requested || 0) === 1)
  });
}

async function architectGetCommand(request, env, nodeId, commandId) {
  await authenticateArchitect(request, env);
  await ensureCommandStorage(env);
  const command = await env.DB.prepare(`
    SELECT c.command_id, c.node_id, c.command_type, c.status, c.created_at, c.completed_at,
      r.output AS result_output, r.exit_code AS result_exit_code
    FROM commands AS c
    LEFT JOIN ssh_console_results AS r ON r.command_id = c.command_id
    WHERE c.command_id = ? AND c.node_id = ?
  `).bind(commandId, nodeId).first();
  if (!command) throw new ApiError(404, "command_not_found");
  return json({
    ok: true,
    command: {
      command_id: command.command_id,
      node_id: command.node_id,
      command_type: command.command_type,
      status: command.status,
      created_at: command.created_at,
      completed_at: command.completed_at,
      result: command.command_type === "ssh_console" && typeof command.result_output === "string"
        ? { output: command.result_output, exit_code: Number(command.result_exit_code || 0) }
        : null
    }
  });
}

async function nodeUpdateAiState(request, env, nodeId, url) {
  const { bytes: bodyBytes, text: bodyText } = await readBody(request, 128 * 1024);
  await authenticateNode(request, env, nodeId, url, bodyBytes);
  const state = normalizeAiState(parseJsonObject(bodyText));
  await upsertNodeAiState(env, nodeId, state);
  const archived = await archiveCompletedAiResponse(env, nodeId, state);
  return json({
    ok: true,
    node_id: nodeId,
    ai: await nodeAiStateResponse(env, nodeId),
    archive: archived ? { saved: true, drive_file_id: archived.drive_file_id } : null
  });
}

async function architectNodeAiState(request, env, nodeId) {
  await authenticateArchitect(request, env);
  const node = await env.DB.prepare(
    "SELECT node_id, status, agent_version, last_seen_at FROM nodes WHERE node_id = ? AND status != 'revoked'"
  ).bind(nodeId).first();
  if (!node) throw new ApiError(404, "node_not_found");
  return json({ ok: true, node, ai: await nodeAiStateResponse(env, nodeId) });
}

async function architectNodeDetails(request, env, nodeId) {
  await authenticateArchitect(request, env);
  await Promise.all([ensureNodeNetworkStorage(env), ensureNodeAiStorage(env), ensureNodeHardwareStorage(env)]);
  const row = await env.DB.prepare(`
    SELECT n.node_id, n.hostname, n.os_name, n.os_version, n.architecture,
      n.agent_version, n.status, n.cpu_percent, n.memory_percent, n.last_seen_at, n.capabilities_json,
      net.lan_ipv4, net.mac_addresses_json,
      net.updated_at AS network_updated_at,
      hw.memory_total_bytes, hw.cpu_logical_count, hw.gpus_json,
      hw.updated_at AS hardware_updated_at
    FROM nodes AS n
    LEFT JOIN node_network_state AS net ON net.node_id = n.node_id
    LEFT JOIN node_hardware_state AS hw ON hw.node_id = n.node_id
    WHERE n.node_id = ? AND n.status != 'revoked'
  `).bind(nodeId).first();
  if (!row) throw new ApiError(404, "node_not_found");

  const macAddresses = safeJson(row.mac_addresses_json, []);
  const gpus = safeJson(row.gpus_json, []);
  const ai = await nodeAiStateResponse(env, nodeId);
  const agentCapability = buildAgentCapabilityContract({
    node_id: row.node_id,
    agent_version: row.agent_version,
    status: row.status,
    last_seen_at: row.last_seen_at,
    capabilities: safeJson(row.capabilities_json, []),
    installed: ai?.installed ? 1 : 0,
    server_running: ai?.server_running ? 1 : 0,
    loaded_model: ai?.loaded_model || null,
    cpu_percent: row.cpu_percent,
    memory_percent: row.memory_percent,
    memory_total_bytes: Number(row.memory_total_bytes || 0) || null,
    cpu_logical_count: Number(row.cpu_logical_count || 0) || null,
    gpus: Array.isArray(gpus) ? gpus : []
  });
  return json({
    ok: true,
    node: {
      node_id: row.node_id,
      hostname: row.hostname,
      os_name: row.os_name,
      os_version: row.os_version,
      architecture: row.architecture,
      agent_version: row.agent_version,
      latest_agent_version: LATEST_NODE_RELEASE.version,
      update_required: row.agent_version !== LATEST_NODE_RELEASE.version,
      capabilities: safeJson(row.capabilities_json, []),
      status: row.status,
      cpu_percent: row.cpu_percent,
      memory_percent: row.memory_percent,
      last_seen_at: row.last_seen_at
    },
    network: {
      lan_ipv4: row.lan_ipv4 || null,
      mac_addresses: Array.isArray(macAddresses) ? macAddresses : [],
      updated_at: row.network_updated_at || null
    },
    hardware: {
      memory_total_bytes: Number(row.memory_total_bytes || 0) || null,
      cpu_logical_count: Number(row.cpu_logical_count || 0) || null,
      gpus: Array.isArray(gpus) ? gpus : [],
      updated_at: row.hardware_updated_at || null
    },
    agent_capability: agentCapability,
    model_recommendation: modelRecommendationProfile({
      memory_total_bytes: Number(row.memory_total_bytes || 0) || null,
      gpus: safeJson(row.gpus_json, [])
    }),
    ai
  });
}

function modelRecommendationProfile(hardware) {
  const ramGiB = Number(hardware?.memory_total_bytes || 0) / (1024 ** 3);
  const gpus = Array.isArray(hardware?.gpus) ? hardware.gpus : [];
  const maxVramGiB = gpus.reduce((best, gpu) =>
    Math.max(best, Number(gpu?.vram_total_bytes || 0) / (1024 ** 3)), 0);

  if (maxVramGiB >= 20 || ramGiB >= 48) {
    return {
      tier: "large",
      target_parameters_b: "12-24B",
      quantization: "Q4_K_M",
      context_length: 32768,
      search_query: "GGUF instruct 14B",
      reason: `RAM ${ramGiB.toFixed(1)} GiB · VRAM ${maxVramGiB.toFixed(1)} GiB`
    };
  }
  if (maxVramGiB >= 10 || ramGiB >= 24) {
    return {
      tier: "medium",
      target_parameters_b: "7-12B",
      quantization: "Q4_K_M",
      context_length: 16384,
      search_query: "GGUF instruct 8B",
      reason: `RAM ${ramGiB.toFixed(1)} GiB · VRAM ${maxVramGiB.toFixed(1)} GiB`
    };
  }
  if (maxVramGiB >= 6 || ramGiB >= 16) {
    return {
      tier: "compact",
      target_parameters_b: "3-7B",
      quantization: "Q4_K_M",
      context_length: 8192,
      search_query: "GGUF instruct 4B",
      reason: `RAM ${ramGiB.toFixed(1)} GiB · VRAM ${maxVramGiB.toFixed(1)} GiB`
    };
  }
  return {
    tier: "micro",
    target_parameters_b: "0.5-3B",
    quantization: "Q4_K_M",
    context_length: 4096,
    search_query: "GGUF instruct 1B",
    reason: ramGiB > 0
      ? `RAM ${ramGiB.toFixed(1)} GiB · dedicated VRAM not confirmed`
      : "Hardware profile is incomplete; conservative model tier selected"
  };
}

function mapHuggingFaceModels(rows, limit = 16) {
  return (Array.isArray(rows) ? rows : [])
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
    .slice(0, limit);
}

async function fetchHuggingFaceModels(query, limit = 30) {
  const hfUrl = new URL("https://huggingface.co/api/models");
  if (query) hfUrl.searchParams.set("search", query);
  hfUrl.searchParams.set("sort", "downloads");
  hfUrl.searchParams.set("direction", "-1");
  hfUrl.searchParams.set("limit", String(Math.max(1, Math.min(100, limit))));
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
  return rows;
}

function inferModelParametersB(modelId, tags = []) {
  const haystack = [modelId, ...(Array.isArray(tags) ? tags : [])].join(" ");
  const matches = [...haystack.matchAll(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*[bB](?:[^A-Za-z0-9]|$)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 1000);
  return matches.length ? Math.min(...matches) : null;
}

function huggingFaceFamilyQuery(modelId) {
  const name = String(modelId || "").split("/").pop() || "";
  const stripped = name
    .replace(/[-_.](?:gguf|instruct|chat|base|it)$/i, "")
    .replace(/[-_.]\d+(?:\.\d+)?[bB](?:[-_.].*)?$/i, "")
    .replace(/[-_.](?:q\d(?:_[A-Za-z0-9]+)?|fp16|bf16|f16)(?:[-_.].*)?$/i, "");
  return (stripped || name).slice(0, 80);
}

async function fetchHuggingFaceModelDetail(modelId) {
  const encoded = String(modelId).split("/").map(encodeURIComponent).join("/");
  let response;
  try {
    response = await fetch("https://huggingface.co/api/models/" + encoded, {
      headers: { "accept": "application/json", "user-agent": "CITADEL-EWS/1.0" }
    });
  } catch {
    throw new ApiError(502, "huggingface_unavailable");
  }
  if (response.status === 404) throw new ApiError(404, "huggingface_model_not_found");
  if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502, "huggingface_search_failed");
  try {
    return await response.json();
  } catch {
    throw new ApiError(502, "huggingface_invalid_response");
  }
}

function modelNodeCompatibility(modelId, detail, hardware) {
  const tags = Array.isArray(detail?.tags) ? detail.tags.map(String) : [];
  const siblings = Array.isArray(detail?.siblings) ? detail.siblings : [];
  const ggufFiles = siblings
    .map((item) => typeof item?.rfilename === "string" ? item.rfilename : "")
    .filter((name) => /\.gguf$/i.test(name));
  const q4Files = ggufFiles.filter((name) => /(?:^|[-_.])Q4(?:[_A-Za-z0-9.-]*)(?:\.gguf)$/i.test(name));
  const gguf = tags.some((tag) => tag.toLowerCase() === "gguf") || ggufFiles.length > 0;
  const parametersB = inferModelParametersB(modelId, tags);
  const ramGiB = Number(hardware?.memory_total_bytes || 0) / (1024 ** 3);
  const gpus = Array.isArray(hardware?.gpus) ? hardware.gpus : [];
  const maxVramGiB = gpus.reduce((best, gpu) =>
    Math.max(best, Number(gpu?.vram_total_bytes || 0) / (1024 ** 3)), 0);
  const estimatedQ4GiB = parametersB ? Math.max(1.2, parametersB * 0.68 + 0.8) : null;

  let status = "unknown";
  if (!gguf) status = "format_unknown";
  else if (q4Files.length === 0) status = "unknown";
  else if (estimatedQ4GiB && (maxVramGiB >= estimatedQ4GiB * 0.9 || ramGiB >= estimatedQ4GiB * 1.35)) status = "recommended";
  else if (estimatedQ4GiB && ramGiB >= estimatedQ4GiB * 1.05) status = "possible";
  else if (estimatedQ4GiB && ramGiB > 0) status = "not_recommended";
  else status = "unknown";

  return {
    status,
    gguf,
    q4_artifact: q4Files.length > 0,
    q4_files: q4Files.slice(0, 24),
    parameters_b: parametersB,
    estimated_q4_memory_gib: q4Files.length && estimatedQ4GiB ? Number(estimatedQ4GiB.toFixed(1)) : null,
    ram_gib: ramGiB ? Number(ramGiB.toFixed(1)) : null,
    max_vram_gib: maxVramGiB ? Number(maxVramGiB.toFixed(1)) : null,
    gguf_files: ggufFiles.slice(0, 24)
  };
}

async function architectSearchModels(request, env, url) {
  await authenticateArchitect(request, env);
  const raw = String(url.searchParams.get("q") || "").trim();
  const query = raw ? requireString(raw, "model_search", 80) : "GGUF instruct";
  const requested = Number(url.searchParams.get("limit") || 60);
  const limit = Number.isInteger(requested) ? Math.max(1, Math.min(80, requested)) : 60;
  const rows = await fetchHuggingFaceModels(query, limit);
  return json({ ok: true, query, source: "huggingface", models: mapHuggingFaceModels(rows, limit) });
}

async function architectModelDetails(request, env, url) {
  await authenticateArchitect(request, env);
  const modelId = normalizeLmModelId(url.searchParams.get("id"));
  const nodeId = String(url.searchParams.get("node_id") || "").trim();
  const detail = await fetchHuggingFaceModelDetail(modelId);
  let hardware = null;
  let recommendation = null;
  if (nodeId) {
    await ensureNodeHardwareStorage(env);
    const row = await env.DB.prepare(
      "SELECT memory_total_bytes, cpu_logical_count, gpus_json, updated_at FROM node_hardware_state WHERE node_id = ?"
    ).bind(nodeId).first();
    if (row) {
      hardware = {
        memory_total_bytes: Number(row.memory_total_bytes || 0) || null,
        cpu_logical_count: Number(row.cpu_logical_count || 0) || null,
        gpus: safeJson(row.gpus_json, []),
        updated_at: row.updated_at || null
      };
      recommendation = modelRecommendationProfile(hardware);
    }
  }

  const familyQuery = huggingFaceFamilyQuery(modelId);
  let alternatives = [];
  if (familyQuery) {
    try {
      alternatives = mapHuggingFaceModels(await fetchHuggingFaceModels(familyQuery, 30), 16)
        .filter((item) => item.id !== modelId);
    } catch {
      alternatives = [];
    }
  }

  const siblings = Array.isArray(detail?.siblings) ? detail.siblings : [];
  return json({
    ok: true,
    model: {
      id: modelId,
      downloads: Number(detail?.downloads || 0),
      likes: Number(detail?.likes || 0),
      pipeline_tag: typeof detail?.pipeline_tag === "string" ? detail.pipeline_tag : null,
      last_modified: detail?.lastModified || detail?.last_modified || null,
      tags: Array.isArray(detail?.tags) ? detail.tags.map(String).slice(0, 40) : [],
      files: siblings
        .map((item) => typeof item?.rfilename === "string" ? item.rfilename : "")
        .filter(Boolean)
        .slice(0, 60)
    },
    hardware,
    recommendation,
    compatibility: modelNodeCompatibility(modelId, detail, hardware),
    alternatives
  });
}

async function architectLmstudioPreflight(request, env, nodeId) {
  await authenticateArchitect(request, env);
  try {
    await Promise.all([ensureCommandStorage(env), ensureNodeAiStorage(env)]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error("LM Studio preflight storage failed", { node_id: nodeId, error: String(error) });
    throw new ApiError(503, "lmstudio_command_storage_unavailable");
  }
  const node = await env.DB.prepare(
    "SELECT node_id, hostname, status, agent_version, os_name, architecture, last_seen_at, " +
    "CASE WHEN last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-5 minutes') THEN 1 ELSE 0 END AS recently_seen " +
    "FROM nodes WHERE node_id = ? AND status != 'revoked'"
  ).bind(nodeId).first();
  if (!node) throw new ApiError(404, "node_not_found");
  if (Number(node.recently_seen || 0) !== 1) throw new ApiError(409, "node_offline");
  if (!agentVersionAtLeast(node.agent_version, "0.3.19")) throw new ApiError(409, "agent_update_required");
  await expireStaleNodeCommands(env, nodeId);
  const pending = await env.DB.prepare(
    "SELECT command_id, command_type, status FROM commands WHERE node_id = ? AND status IN ('pending','accepted') LIMIT 1"
  ).bind(nodeId).first();
  if (pending) throw new ApiError(409, "command_already_pending");
  // Validate the signing configuration before the user starts an installation.
  controllerPrivateJwk(env);
  const asset = lmstudioInstallAssetForNode(node);
  return json({
    ok: true,
    node: {
      node_id: node.node_id,
      hostname: node.hostname,
      agent_version: node.agent_version,
      os_name: node.os_name,
      architecture: node.architecture
    },
    ai: await nodeAiStateResponse(env, nodeId),
    asset
  });
}

async function architectRecommendModels(request, env, nodeId) {
  await authenticateArchitect(request, env);
  await ensureNodeHardwareStorage(env);
  const node = await env.DB.prepare(`
    SELECT n.node_id, n.hostname, n.architecture, n.status, n.last_seen_at,
      h.memory_total_bytes, h.cpu_logical_count, h.gpus_json, h.updated_at AS hardware_updated_at
    FROM nodes AS n
    LEFT JOIN node_hardware_state AS h ON h.node_id = n.node_id
    WHERE n.node_id = ? AND n.status != 'revoked'
  `).bind(nodeId).first();
  if (!node) throw new ApiError(404, "node_not_found");
  const hardware = {
    memory_total_bytes: Number(node.memory_total_bytes || 0) || null,
    cpu_logical_count: Number(node.cpu_logical_count || 0) || null,
    gpus: safeJson(node.gpus_json, []),
    updated_at: node.hardware_updated_at || null
  };
  const profile = modelRecommendationProfile(hardware);
  let models = [];
  let catalogStatus = "ready";
  try {
    const rows = await fetchHuggingFaceModels(profile.search_query, 40);
    models = mapHuggingFaceModels(rows, 8).filter((item) => item.gguf);
    if (!models.length) models = mapHuggingFaceModels(rows, 8);
  } catch {
    catalogStatus = "unavailable";
  }
  if (!models.length && profile.tier === "micro") {
    models = [{ id: "ibm/granite-4-micro", downloads: 0, likes: 0, pipeline_tag: "text-generation", gguf: false, last_modified: null }];
  }
  return json({
    ok: true,
    node: { node_id: node.node_id, hostname: node.hostname, architecture: node.architecture },
    hardware,
    recommendation: profile,
    catalog_status: catalogStatus,
    models
  });
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
    SELECT n.node_id, n.agent_version, n.status, n.last_seen_at, net.lan_ipv4
    FROM nodes AS n
    JOIN node_network_state AS net ON net.node_id = n.node_id
    WHERE n.node_id != ?
      AND n.status = 'online'
      AND datetime(n.last_seen_at) >= datetime('now', '-5 minutes')
    ORDER BY datetime(n.last_seen_at) DESC
    LIMIT 100
  `).bind(targetNodeId).all();
  const relay = (relaysQuery.results || []).find((candidate) =>
    wakeRelayEligible(candidate) && subnet24(candidate.lan_ipv4) === prefix
  );
  if (!relay) throw new ApiError(409, "wake_relay_unavailable");

  // Wake is an explicit control action, so reclaim an expired command slot here
  // instead of making every steady-state agent poll perform cleanup.
  await expireStaleNodeCommands(env, relay.node_id);
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
  await persistWakePeerCommand(env, {
    commandId, relayNodeId: relay.node_id, payloadJson, signature, createdAt,
    actorId: "test-console", targetNodeId,
    auditDetails: { relay_node_id: relay.node_id, target_lan_ipv4: target.lan_ipv4 }
  });

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

export async function persistWakePeerCommand(env, {
  commandId, relayNodeId, payloadJson, signature, createdAt,
  actorId, targetNodeId, auditDetails
}) {
  try {
    await env.DB.prepare(
      "INSERT INTO commands (command_id, node_id, command_type, payload_json, signature, status, created_at) " +
      "VALUES (?, ?, 'wake_peer', ?, ?, 'pending', ?)"
    ).bind(commandId, relayNodeId, payloadJson, signature, createdAt).run();
  } catch (error) {
    if (/unique|idx_commands_one_active_per_node|commands\.node_id/i.test(String(error))) {
      throw new ApiError(409, "wake_relay_busy");
    }
    const persisted = await env.DB.prepare(
      "SELECT command_id FROM commands WHERE command_id = ?"
    ).bind(commandId).first().catch(() => null);
    if (!persisted) {
      console.error("Wake command persistence failed", { relay_node_id: relayNodeId, error: String(error) });
      throw new ApiError(503, "wake_queue_failed");
    }
  }
  try {
    await env.DB.prepare(
      "INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, details_json) " +
      "VALUES ('architect', ?, 'node.wake.requested', 'node', ?, ?)"
    ).bind(actorId, targetNodeId, JSON.stringify(auditDetails)).run();
  } catch (error) {
    console.error("Wake command audit persistence failed", { command_id: commandId, error: String(error) });
  }
}

async function architectWakeAll(request, env) {
  const actor = await authenticateArchitect(request, env);
  await Promise.all([ensureNodeNetworkStorage(env), ensureCommandStorage(env)]);
  const rows = await env.DB.prepare(`
    SELECT n.node_id, n.hostname, n.agent_version, n.status, n.last_seen_at,
      net.lan_ipv4, net.mac_addresses_json
    FROM nodes AS n
    LEFT JOIN node_network_state AS net ON net.node_id = n.node_id
    WHERE n.status != 'revoked'
    ORDER BY datetime(n.last_seen_at) DESC
    LIMIT 500
  `).all();
  const nodes = (rows.results || []).filter((node) => !isTestNodeRecord(node));
  const liveRelays = nodes.filter((node) => wakeRelayEligible(node));
  const offlineTargets = nodes.filter((node) => operationalNodeState(node) !== "live");
  const queued = [];
  const skipped = [];
  const usedRelays = new Set();

  for (const target of offlineTargets) {
    const macs = safeJson(target.mac_addresses_json, []);
    const targetMac = Array.isArray(macs) ? macs.map(normalizeMac).find(Boolean) : null;
    const prefix = subnet24(target.lan_ipv4);
    const targetNetwork = {
      node_id: target.node_id,
      hostname: target.hostname || null,
      mac: targetMac,
      lan_ipv4: target.lan_ipv4 || null,
      subnet: prefix ? prefix + ".0/24" : null
    };
    if (!targetMac || !target.lan_ipv4 || !prefix) {
      skipped.push({ ...targetNetwork, relay_node_id: null, reason: "wake_network_identity_unavailable" });
      continue;
    }

    let relay = null;
    let matchingRelayBusy = false;
    for (const candidate of liveRelays) {
      if (candidate.node_id === target.node_id) continue;
      if (subnet24(candidate.lan_ipv4) !== prefix) continue;
      if (usedRelays.has(candidate.node_id)) {
        matchingRelayBusy = true;
        continue;
      }
      await expireStaleNodeCommands(env, candidate.node_id);
      const pending = await env.DB.prepare(
        "SELECT command_id FROM commands WHERE node_id = ? AND status IN ('pending','accepted') LIMIT 1"
      ).bind(candidate.node_id).first();
      if (!pending) {
        relay = candidate;
        break;
      }
      matchingRelayBusy = true;
    }
    if (!relay) {
      skipped.push({ ...targetNetwork, relay_node_id: null,
        reason: matchingRelayBusy ? "wake_relay_busy" : "wake_relay_unavailable" });
      continue;
    }

    const commandId = "command_" + crypto.randomUUID();
    const payloadJson = JSON.stringify({
      target_node_id: target.node_id,
      target_mac: targetMac,
      target_lan_ipv4: target.lan_ipv4
    });
    const createdAt = new Date().toISOString();
    const signature = await signControllerCommand(
      env, commandId, relay.node_id, "wake_peer", payloadJson, createdAt
    );
    try {
      await persistWakePeerCommand(env, {
        commandId, relayNodeId: relay.node_id, payloadJson, signature, createdAt,
        actorId: actor.actor_id || "architect", targetNodeId: target.node_id,
        auditDetails: { relay_node_id: relay.node_id, target_lan_ipv4: target.lan_ipv4, batch: true }
      });
      usedRelays.add(relay.node_id);
      queued.push({
        ...targetNetwork,
        target_node_id: target.node_id,
        relay_node_id: relay.node_id,
        command_id: commandId
      });
    } catch (error) {
      skipped.push({
        ...targetNetwork,
        relay_node_id: relay.node_id,
        reason: error instanceof ApiError ? error.code : "wake_queue_failed"
      });
    }
  }

  return json({
    ok: true,
    wake_all: {
      offline_targets: offlineTargets.length,
      live_relays: liveRelays.length,
      queued_count: queued.length,
      skipped_count: skipped.length,
      queued,
      skipped,
      retry_after_seconds: queued.length && skipped.length ? 20 : null
    }
  }, queued.length ? 202 : 200);
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

async function handleApi(request, env, url, executionCtx = null) {
  if (url.pathname === "/api/health") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }

    try {
      const row = await env.DB.prepare("SELECT 1 AS ok").first();
      let payloadStorageError = null;
      const [controllerSigning, reportStorage, sessionStorage, payloadStorage] = await Promise.all([
        importControllerPrivateKey(env)
          .then(() => "ready")
          .catch(() => "unavailable"),
        ensureReportStorage(env)
          .then(() => "ready")
          .catch(() => "unavailable"),
        ensureSessionStorage(env)
          .then(() => "ready")
          .catch(() => "unavailable"),
        googleDriveWritablePreflight(env)
          .then(() => "ready")
          .catch((error) => {
            payloadStorageError = error instanceof ApiError ? error.code : "drive_payload_storage_unavailable";
            return "unavailable";
          })
      ]);

      let projectExecution = "unavailable";
      let projectReadinessError = null;
      let projectOnlineNodes = 0;
      let projectAiReadyWorkers = 0;
      let projectPythonReadyWorkers = 0;
      let liveProjectNodes = [];
      try {
        const projectNodes = await env.DB.prepare(`
          SELECT node_id, hostname, status, last_seen_at, capabilities_json
          FROM nodes
          WHERE status = 'online'
            AND datetime(last_seen_at) >= datetime('now', '-5 minutes')
          ORDER BY last_seen_at DESC
          LIMIT 500
        `).all();
        liveProjectNodes = (projectNodes.results || [])
          .filter((node) => !isTestNodeRecord(node));
        projectOnlineNodes = liveProjectNodes.length;
        projectPythonReadyWorkers = liveProjectNodes
          .filter((node) => projectNodeReady(node, "architect_python")).length;
      } catch (error) {
        projectReadinessError = "node_presence_query_failed";
        console.error("Project readiness node query failed", error);
      }

      if (projectReadinessError === null && projectOnlineNodes === 0) {
        projectExecution = "waiting_for_online_node";
      } else if (projectReadinessError === null) {
        try {
          await ensureNodeAiStorage(env);
          const aiRows = await env.DB.prepare(`
            SELECT ai.node_id, ai.installed, ai.loaded_model, ai.server_running,
              json_extract(air.state_json, '$.inference_ready') AS inference_ready
            FROM node_ai_state AS ai
            LEFT JOIN node_ai_runtime_state AS air ON air.node_id = ai.node_id
            ORDER BY ai.updated_at DESC
            LIMIT 500
          `).all();
          const aiByNode = new Map(
            (aiRows.results || []).map((row) => [row.node_id, row])
          );
          projectAiReadyWorkers = liveProjectNodes
            .map((node) => ({ ...node, ...(aiByNode.get(node.node_id) || {}) }))
            .filter((node) => projectNodeReady(node, "architect_manual")).length;
          projectExecution = projectAiReadyWorkers > 0
            ? "ready"
            : "waiting_for_ai_worker";
        } catch (error) {
          const detail = String(error || "").toLowerCase();
          projectReadinessError = detail.includes("daily row read")
            ? "d1_read_limit"
            : detail.includes("daily row write")
              ? "d1_write_limit"
              : detail.includes("no such table")
                ? "ai_state_schema_missing"
                : "ai_state_query_failed";
          projectExecution = "unavailable";
          console.error("Project readiness AI query failed", error);
        }
      }

      return json({
        ok: row?.ok === 1 &&
          controllerSigning === "ready" &&
          reportStorage === "ready" &&
          sessionStorage === "ready",
        service: "citadel-ai",
        database: "citadel-control",
        controller_signing: controllerSigning,
        report_storage: reportStorage,
        session_storage: sessionStorage,
        payload_storage: payloadStorage,
        payload_storage_provider: "google_drive",
        payload_storage_error: payloadStorageError,
        openrouter_quality: openRouterQualityConfig(env).configured ? "configured" : "unconfigured",
        project_execution: projectExecution,
        project_readiness_error: projectReadinessError,
        project_online_nodes: projectOnlineNodes,
        project_ai_ready_workers: projectAiReadyWorkers,
        project_python_ready_workers: projectPythonReadyWorkers
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

  if (url.pathname === "/api/v1/architect/security/access-tokens") {
    if (request.method === "GET") return architectListAccessTokens(request, env);
    if (request.method === "POST") return architectCreateAccessToken(request, env);
    return methodNotAllowed(["GET", "POST"]);
  }

  const accessTokenMatch = url.pathname.match(
    /^\/api\/v1\/architect\/security\/access-tokens\/([^/]+)$/
  );
  if (accessTokenMatch) {
    return request.method === "DELETE"
      ? architectRevokeAccessToken(request, env, decodeURIComponent(accessTokenMatch[1]))
      : methodNotAllowed(["DELETE"]);
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

  if (url.pathname === "/api/v1/status/d1-usage") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return json(await d1UsageStatus(env), 200, {
      "cache-control": "public, max-age=60, stale-while-revalidate=240"
    });
  }

  if (url.pathname === "/api/v1/status/d1-retention") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return json(await readD1RetentionStatus(env), 200, { "cache-control": "public, max-age=300" });
  }

  if (url.pathname === "/api/v1/architect/d1-usage") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    await authenticateArchitect(request, env);
    return json(await d1UsageOverview(env));
  }

  if (url.pathname === "/api/v1/architect/d1-guardian") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    await authenticateArchitect(request, env);
    return json(await readD1GuardianStatus(env));
  }

  if (url.pathname === "/api/v1/architect/d1-guardian/run") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    await authenticateArchitect(request, env);
    const result = await runD1Guardian(env, {
      expireStaleCommands,
      recoverStaleProjectAssignments,
      force: true
    });
    return json(result);
  }

  if (url.pathname === "/api/v1/architect/enterprise") {
    return request.method === "GET"
      ? architectEnterpriseOverview(request, env)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/enterprise/policy") {
    return request.method === "POST"
      ? architectSetEnterprisePolicy(request, env)
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/enterprise/sites") {
    return request.method === "POST"
      ? architectCreateEnterpriseSite(request, env)
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/enterprise/groups") {
    return request.method === "POST"
      ? architectCreateEnterpriseGroup(request, env)
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/node-groups") {
    return request.method === "POST"
      ? architectCreateNodeGroup(request, env)
      : methodNotAllowed(["POST"]);
  }

  const deleteNodeMatch = url.pathname.match(/^\/api\/v1\/architect\/nodes\/([^/]+)$/);
  if (deleteNodeMatch) {
    return request.method === "DELETE"
      ? architectDeleteNode(request, env, decodeURIComponent(deleteNodeMatch[1]))
      : methodNotAllowed(["DELETE"]);
  }

  if (url.pathname === "/api/v1/architect/enterprise/recovery-manifest") {
    return request.method === "GET"
      ? architectEnterpriseRecoveryManifest(request, env)
      : methodNotAllowed(["GET"]);
  }

  const enterpriseScopeMatch = url.pathname.match(
    /^\/api\/v1\/architect\/enterprise\/nodes\/([^/]+)\/scope$/
  );
  if (enterpriseScopeMatch) {
    return request.method === "POST"
      ? architectSetNodeEnterpriseScope(
          request,
          env,
          decodeURIComponent(enterpriseScopeMatch[1])
        )
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/release") {
    return request.method === "GET"
      ? architectRelease(request, env)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/update-all") {
    if (request.method === "POST") return startUpdateAllRollout(request, env);
    if (request.method === "GET") return architectUpdateRolloutStatus(request, env);
    return methodNotAllowed(["GET", "POST"]);
  }

  if (url.pathname === "/api/v1/architect/wake-all") {
    return request.method === "POST"
      ? architectWakeAll(request, env)
      : methodNotAllowed(["POST"]);
  }

  if (url.pathname === "/api/v1/architect/models/search") {
    return request.method === "GET"
      ? architectSearchModels(request, env, url)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/models/details") {
    return request.method === "GET"
      ? architectModelDetails(request, env, url)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/work-roles") {
    return request.method === "GET"
      ? architectWorkRoles(request, env)
      : methodNotAllowed(["GET"]);
  }

  if (url.pathname === "/api/v1/architect/machines") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    await authenticateArchitect(request, env);
    const { nodes, commands, groups } = await readArchitectMachines(env);
    const commandRows = commands.results || [];
    const latestCommands = new Map();
    for (const command of commandRows) {
      if (!latestCommands.has(command.node_id)) latestCommands.set(command.node_id, command);
    }
    const rawNodes = nodes.results || [];
    const liveRelays = rawNodes.filter((node) => wakeRelayEligible(node));
    const machineNodes = rawNodes.map((node) => {
      const macAddresses = safeJson(node.mac_addresses_json, []);
      const prefix = subnet24(node.lan_ipv4);
      const relay = prefix && Array.isArray(macAddresses) && macAddresses.length
        ? liveRelays.find((candidate) => candidate.node_id !== node.node_id && subnet24(candidate.lan_ipv4) === prefix)
        : null;
      const latestCommand = latestCommands.get(node.node_id);
      return {
        ...node,
        mac_addresses: Array.isArray(macAddresses) ? macAddresses : [],
        mac_addresses_json: undefined,
        lmstudio_installed: node.ai_installed,
        lmstudio_server_running: node.ai_server_running,
        lmstudio_selected_model: node.ai_selected_model,
        lmstudio_loaded_model: node.ai_loaded_model,
        lmstudio_updated_at: node.ai_updated_at,
        lmstudio_runtime: safeJson(node.ai_runtime_json, {}),
        ai_runtime_json: undefined,
        last_command_type: latestCommand?.command_type || null,
        last_command_status: latestCommand?.status || null,
        last_command_at: latestCommand?.completed_at || latestCommand?.created_at || null,
        wake_available: node.status === "offline" && Boolean(relay),
        wake_relay_node_id: relay?.node_id || null,
        latest_agent_version: LATEST_NODE_RELEASE.version,
        update_required: node.agent_version !== LATEST_NODE_RELEASE.version
      };
    });
    return json({ok:true, nodes:machineNodes, commands:commandRows, groups:groups.results || []});
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

  const architectInteractiveMatch = url.pathname.match(
    /^\/api\/v1\/architect\/projects\/([^/]+)\/interactive\/([^/]+)$/
  );
  if (architectInteractiveMatch) {
    const projectId = decodeURIComponent(architectInteractiveMatch[1]);
    const workItemId = decodeURIComponent(architectInteractiveMatch[2]);
    if (request.method === "GET") {
      return architectGetInteractiveThread(request, env, projectId, workItemId);
    }
    if (request.method === "POST") {
      return architectPostInteractiveMessage(request, env, projectId, workItemId);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  const architectProjectMatch = url.pathname.match(
    /^\/api\/v1\/architect\/projects\/([^/]+)$/
  );
  if (architectProjectMatch) {
    return request.method === "GET"
      ? architectGetProject(request, env, decodeURIComponent(architectProjectMatch[1]), executionCtx)
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

  if (url.pathname === "/api/v1/architect/ssh/connect") {
    return request.method === "GET" ? architectSshConnect(request, env) : methodNotAllowed(["GET"]);
  }
  if (url.pathname === '/api/v1/architect/ssh/relay/connect') {
    return request.method === 'GET' ? architectSshRelayConnect(request, env) : methodNotAllowed(['GET']);
  }
  const architectSshSessionMatch = url.pathname.match(/^\/api\/v1\/architect\/nodes\/([^/]+)\/ssh\/session$/);
  if (architectSshSessionMatch) {
    return ["GET", "POST"].includes(request.method)
      ? architectSshSession(request, env, decodeURIComponent(architectSshSessionMatch[1])) : methodNotAllowed(["GET", "POST"]);
  }

  const architectNodeSshMatch = url.pathname.match(
    /^\/api\/v1\/architect\/nodes\/([^/]+)\/ssh$/
  );
  if (architectNodeSshMatch) {
    const nodeId = decodeURIComponent(architectNodeSshMatch[1]);
    return ["GET", "PUT", "DELETE"].includes(request.method)
      ? architectNodeSsh(request, env, nodeId)
      : methodNotAllowed(["GET", "PUT", "DELETE"]);
  }

  const architectNodeDetailsMatch = url.pathname.match(
    /^\/api\/v1\/architect\/nodes\/([^/]+)\/details$/
  );
  if (architectNodeDetailsMatch) {
    return request.method === "GET"
      ? architectNodeDetails(request, env, decodeURIComponent(architectNodeDetailsMatch[1]))
      : methodNotAllowed(["GET"]);
  }

  const architectModelRecommendationsMatch = url.pathname.match(
    /^\/api\/v1\/architect\/nodes\/([^/]+)\/model-recommendations$/
  );
  if (architectModelRecommendationsMatch) {
    return request.method === "GET"
      ? architectRecommendModels(request, env, decodeURIComponent(architectModelRecommendationsMatch[1]))
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

  const architectLmstudioPreflightMatch = url.pathname.match(
    /^\/api\/v1\/architect\/nodes\/([^/]+)\/lmstudio-preflight$/
  );
  if (architectLmstudioPreflightMatch) {
    return request.method === "GET"
      ? architectLmstudioPreflight(request, env, decodeURIComponent(architectLmstudioPreflightMatch[1]))
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

  const architectCommandCancelMatch = url.pathname.match(
    /^\/api\/v1\/architect\/nodes\/([^/]+)\/commands\/([^/]+)\/cancel$/
  );
  if (architectCommandCancelMatch) {
    return request.method === "POST"
      ? architectCancelCommand(
          request,
          env,
          decodeURIComponent(architectCommandCancelMatch[1]),
          decodeURIComponent(architectCommandCancelMatch[2])
        )
      : methodNotAllowed(["POST"]);
  }

  const architectCommandStatusMatch = url.pathname.match(
    /^\/api\/v1\/architect\/nodes\/([^/]+)\/commands\/([^/]+)$/
  );
  if (architectCommandStatusMatch) {
    return request.method === "GET"
      ? architectGetCommand(
          request,
          env,
          decodeURIComponent(architectCommandStatusMatch[1]),
          decodeURIComponent(architectCommandStatusMatch[2])
        )
      : methodNotAllowed(["GET"]);
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

  let relayMatch = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/ssh\/relay$/);
  if (relayMatch) return request.method === 'GET'
    ? nodeSshRelayConnect(request, env, decodeURIComponent(relayMatch[1]), url) : methodNotAllowed(['GET']);

  let match = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/heartbeat$/);
  if (match) {
    return request.method === "POST"
      ? heartbeat(request, env, decodeURIComponent(match[1]), url)
      : methodNotAllowed(["POST"]);
  }

  match = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/sync$/);
  if (match) {
    return request.method === "POST"
      ? syncNode(request, env, decodeURIComponent(match[1]), url)
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

  match = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/commands\/([^/]+)\/cancel-state$/);
  if (match) {
    return request.method === "GET"
      ? nodeCommandCancelState(
          request,
          env,
          decodeURIComponent(match[1]),
          decodeURIComponent(match[2]),
          url
        )
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
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleApi(request, env, url, executionCtx);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 503 && url.pathname.startsWith("/api/v1/nodes/") && /^[a-z_]{1,80}$/.test(error.code)) {
          console.warn("node_control_request_failed", error.code);
        }
        return json({ ok: false, error: error.code }, error.status);
      }

      const quotaResponse = d1QuotaResponse(error);
      if (quotaResponse) return quotaResponse;

      const requestId = crypto.randomUUID();
      const d1Code = d1ServiceErrorCode(error, "controller");
      console.error(d1Code ? "Unhandled D1 API error" : "Unhandled API error", {
        request_id: requestId,
        method: request.method,
        pathname: url.pathname
      }, error);
      if (d1Code) {
        return json({ ok: false, error: d1Code, request_id: requestId }, 503);
      }
      return json({ ok: false, error: "internal_error", request_id: requestId }, 500);
    }
  }
};
