import {
  TelemetryError,
  authenticateArchitect,
  json,
  methodNotAllowed,
  parseJsonObject,
  readBodyText,
  safeJson,
  sha256Hex
} from "../telemetry/common.js";

const CONTROLLER_COMMAND_PUBLIC_X = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0";
const SSH_PORT = 22222;
const SSH_MIN_MINUTES = 5;
const SSH_MAX_MINUTES = 120;
const SSH_KEY_TYPES = new Set(["ssh-ed25519", "ecdsa-sha2-nistp256"]);

export const LATEST_NODE_RELEASE = Object.freeze({
  version: "0.3.1",
  files: [
    {
      path: "citadel_node_v1.py",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/citadel_node_v1.py",
      sha256: "b7731e1149d5a3354fe5d45745df01ad6129b40a13e27d94d693fcdff38ee30e"
    },
    {
      path: "citadel_node_v2.py",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/citadel_node_v2.py",
      sha256: "b7239603036ace8cfd9109d16657a95225b0e2b8eacbe59df1ae764e90106d26"
    }
  ]
});

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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
    throw new TelemetryError(503, "controller_signing_not_configured");
  }

  if (
    !privateJwk ||
    privateJwk.kty !== "OKP" ||
    privateJwk.crv !== "Ed25519" ||
    privateJwk.x !== CONTROLLER_COMMAND_PUBLIC_X ||
    typeof privateJwk.d !== "string"
  ) {
    throw new TelemetryError(503, "controller_signing_not_configured");
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
  throw new TelemetryError(503, "controller_signing_not_configured");
}

async function signControllerCommand(env, commandId, nodeId, commandType, payloadJson, createdAt) {
  const { key, algorithm } = await importControllerPrivateKey(env);
  const payloadHash = await sha256Hex(payloadJson);
  const canonical = controllerCommandCanonical(
    commandId,
    nodeId,
    commandType,
    payloadHash,
    createdAt
  );
  try {
    const signature = await crypto.subtle.sign(
      algorithm,
      key,
      new TextEncoder().encode(canonical)
    );
    return bytesToBase64Url(signature);
  } catch {
    throw new TelemetryError(503, "controller_signing_not_configured");
  }
}

function normalizePublicKey(value) {
  if (typeof value !== "string") throw new TelemetryError(400, "invalid_ssh_public_key");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1024 || /[\r\n]/.test(trimmed)) {
    throw new TelemetryError(400, "invalid_ssh_public_key");
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || parts.length > 3 || !SSH_KEY_TYPES.has(parts[0])) {
    throw new TelemetryError(400, "invalid_ssh_public_key");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1]) || parts[1].length > 900) {
    throw new TelemetryError(400, "invalid_ssh_public_key");
  }
  return parts.join(" ");
}

function parseSshState(capabilitiesValue) {
  const capabilities = Array.isArray(capabilitiesValue)
    ? capabilitiesValue
    : safeJson(capabilitiesValue, []);
  const list = Array.isArray(capabilities) ? capabilities.map(String) : [];
  const findValue = (prefix) => {
    const item = list.find((value) => value.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
  };
  const expiryRaw = findValue("ssh-expires:");
  const expiryEpoch = /^\d{10}$/.test(expiryRaw || "") ? Number(expiryRaw) : null;
  const notExpired = expiryEpoch === null || expiryEpoch * 1000 > Date.now();
  return {
    supported: list.includes("ssh-control"),
    provisioned: list.includes("ssh-provisioned"),
    service_running: list.includes("ssh-service-running"),
    enabled: list.includes("ssh-enabled") && notExpired,
    port: Number(findValue("ssh-port:")) || SSH_PORT,
    username: findValue("ssh-user:"),
    host_fingerprint: findValue("ssh-fingerprint:"),
    expires_at_epoch: list.includes("ssh-enabled") ? expiryEpoch : null
  };
}

async function createSignedCommand(env, nodeId, commandType, payload) {
  const node = await env.DB.prepare(
    "SELECT node_id, status FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();
  if (!node) throw new TelemetryError(404, "node_not_found");
  if (node.status === "revoked") throw new TelemetryError(409, "node_revoked");

  const pending = await env.DB.prepare(
    "SELECT command_id FROM commands " +
    "WHERE node_id = ? AND status IN ('pending', 'accepted') LIMIT 1"
  ).bind(nodeId).first();
  if (pending) throw new TelemetryError(409, "command_already_pending");

  const commandId = "command_" + crypto.randomUUID();
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
  const detailsJson = JSON.stringify({
    node_id: nodeId,
    command_type: commandType,
    bounded_control: true
  });

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO commands (" +
      "command_id, node_id, command_type, payload_json, signature, status, created_at" +
      ") VALUES (?, ?, ?, ?, ?, 'pending', ?)"
    ).bind(commandId, nodeId, commandType, payloadJson, signature, createdAt),
    env.DB.prepare(
      "INSERT INTO audit_events (" +
      "actor_type, actor_id, action, target_type, target_id, details_json" +
      ") VALUES ('architect', 'test-console', 'command.created', 'command', ?, ?)"
    ).bind(commandId, detailsJson)
  ]);

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

async function architectSshStatus(request, env) {
  await authenticateArchitect(request, env);
  const query = await env.DB.prepare(
    "SELECT node_id, hostname, os_name, agent_version, status, last_seen_at, capabilities_json " +
    "FROM nodes WHERE status != 'revoked' ORDER BY last_seen_at DESC LIMIT 100"
  ).all();
  return json({
    ok: true,
    nodes: (query.results || []).map((node) => ({
      node_id: node.node_id,
      hostname: node.hostname,
      os_name: node.os_name,
      agent_version: node.agent_version,
      status: node.status,
      last_seen_at: node.last_seen_at,
      ssh: parseSshState(node.capabilities_json)
    }))
  });
}

async function publicSshStatus(env) {
  const query = await env.DB.prepare(
    "SELECT nn.node_number, n.capabilities_json " +
    "FROM node_numbers AS nn JOIN nodes AS n ON n.node_id = nn.node_id " +
    "WHERE n.status != 'revoked' ORDER BY nn.node_number ASC LIMIT 500"
  ).all();
  return json({
    ok: true,
    nodes: (query.results || []).map((node) => {
      const state = parseSshState(node.capabilities_json);
      return {
        node_number: node.node_number,
        ssh: {
          supported: state.supported,
          provisioned: state.provisioned,
          enabled: state.enabled
        }
      };
    })
  });
}

async function architectSshCommand(request, env, nodeId) {
  await authenticateArchitect(request, env);
  const bodyText = await readBodyText(request, 8 * 1024);
  const body = parseJsonObject(bodyText);
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";

  if (action === "disable") {
    return createSignedCommand(env, nodeId, "ssh_disable", {});
  }
  if (action !== "enable") {
    throw new TelemetryError(400, "invalid_ssh_action");
  }

  const duration = body.duration_minutes === undefined ? 30 : body.duration_minutes;
  if (!Number.isInteger(duration) || duration < SSH_MIN_MINUTES || duration > SSH_MAX_MINUTES) {
    throw new TelemetryError(400, "invalid_ssh_duration");
  }
  const publicKey = normalizePublicKey(body.public_key);
  return createSignedCommand(env, nodeId, "ssh_enable", {
    duration_minutes: duration,
    public_key: publicKey
  });
}

async function architectLatestRelease(request, env) {
  await authenticateArchitect(request, env);
  return json({ ok: true, release: LATEST_NODE_RELEASE });
}

function errorResponse(error) {
  if (error instanceof TelemetryError) {
    return json(
      { ok: false, error: error.code },
      error.status,
      error.headers || {}
    );
  }
  console.error("ssh_control_internal_error", error);
  return json({ ok: false, error: "internal_error" }, 500);
}

export async function handleControlExtension(request, env, url) {
  const path = url.pathname;
  try {
    if (path === "/api/v1/hub/ssh") {
      return request.method === "GET"
        ? publicSshStatus(env)
        : methodNotAllowed(["GET"]);
    }

    if (path === "/api/v1/architect/ssh") {
      return request.method === "GET"
        ? architectSshStatus(request, env)
        : methodNotAllowed(["GET"]);
    }

    if (path === "/api/v1/architect/release") {
      return request.method === "GET"
        ? architectLatestRelease(request, env)
        : methodNotAllowed(["GET"]);
    }

    const sshMatch = path.match(/^\/api\/v1\/architect\/nodes\/([^/]+)\/ssh$/);
    if (sshMatch) {
      return request.method === "POST"
        ? architectSshCommand(request, env, decodeURIComponent(sshMatch[1]))
        : methodNotAllowed(["POST"]);
    }

    const commandMatch = path.match(/^\/api\/v1\/architect\/nodes\/([^/]+)\/commands$/);
    if (commandMatch && request.method === "POST") {
      const cloned = request.clone();
      let body;
      try {
        body = parseJsonObject(await readBodyText(cloned, 8 * 1024));
      } catch {
        return null;
      }
      if (body.command_type !== "update") return null;
      await authenticateArchitect(request, env);
      return createSignedCommand(
        env,
        decodeURIComponent(commandMatch[1]),
        "update",
        LATEST_NODE_RELEASE
      );
    }

    return null;
  } catch (error) {
    return errorResponse(error);
  }
}
