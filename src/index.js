const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

const MAX_ENROLLMENT_BODY_BYTES = 16 * 1024;
const MAX_NODE_BODY_BYTES = 64 * 1024;
const SIGNATURE_WINDOW_SECONDS = 300;
const ALLOWED_OUTCOMES = new Set(["success", "failed", "partial"]);
const ALLOWED_COMMAND_ACKS = new Set(["accepted", "completed", "failed"]);

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

async function readBodyText(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ApiError(413, "request_too_large");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ApiError(413, "request_too_large");
  }
  return text;
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return bytesToHex(digest);
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

  const rawKey = decodeBase64Url(jwk.x);
  if (rawKey.byteLength !== 32) {
    throw new ApiError(400, "invalid_public_key");
  }

  return JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x });
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

async function authenticateNode(request, env, nodeId, url, bodyText) {
  const headerNodeId = request.headers.get("x-node-id");
  const timestamp = request.headers.get("x-node-timestamp");
  const signatureValue = request.headers.get("x-node-signature");

  if (!headerNodeId || headerNodeId !== nodeId || !timestamp || !signatureValue) {
    throw new ApiError(401, "node_authentication_required");
  }
  if (!/^\d{10,13}$/.test(timestamp)) {
    throw new ApiError(401, "invalid_timestamp");
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
    "SELECT node_id, public_key, status FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();

  if (!node) {
    throw new ApiError(401, "invalid_node");
  }
  if (node.status === "revoked") {
    throw new ApiError(403, "node_revoked");
  }

  let publicJwk;
  try {
    publicJwk = JSON.parse(node.public_key);
  } catch {
    throw new ApiError(401, "invalid_node_key");
  }

  const bodyHash = await sha256Hex(bodyText);
  const canonicalRequest = [
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    timestamp,
    bodyHash
  ].join("\n");

  let verified = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const signature = decodeBase64Url(signatureValue);
    verified = signature.byteLength === 64 && await crypto.subtle.verify(
      "Ed25519",
      key,
      signature,
      new TextEncoder().encode(canonicalRequest)
    );
  } catch {
    verified = false;
  }

  if (!verified) {
    throw new ApiError(401, "invalid_signature");
  }
  return node;
}

async function enrollNode(request, env) {
  const bodyText = await readBodyText(request, MAX_ENROLLMENT_BODY_BYTES);
  const body = parseJsonObject(bodyText);

  const enrollmentToken = requireString(body.enrollment_token, "enrollment_token", 512);
  if (enrollmentToken.length < 16) {
    throw new ApiError(400, "invalid_enrollment_token");
  }

  const publicKey = normalizePublicKey(body.public_key);
  const hostname = requireString(body.hostname, "hostname", 255);
  const osName = requireString(body.os_name, "os_name", 80);
  const osVersion = optionalString(body.os_version, "os_version", 80);
  const architecture = optionalString(body.architecture, "architecture", 80);
  const agentVersion = requireString(body.agent_version, "agent_version", 80);
  const capabilitiesJson = normalizeCapabilities(body.capabilities);
  const tokenHash = await sha256Hex(enrollmentToken);
  const nodeId = `node_${crypto.randomUUID()}`;
  const detailsJson = JSON.stringify({ hostname, os_name: osName, agent_version: agentVersion });

  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO nodes (
          node_id, public_key, hostname, os_name, os_version,
          architecture, agent_version, status, capabilities_json
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 'online', ?
        WHERE EXISTS (
          SELECT 1
          FROM enrollment_batches
          WHERE token_hash = ?
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
            AND used_nodes < max_nodes
        )
      `).bind(
        nodeId,
        publicKey,
        hostname,
        osName,
        osVersion,
        architecture,
        agentVersion,
        capabilitiesJson,
        tokenHash
      ),
      env.DB.prepare(`
        UPDATE enrollment_batches
        SET used_nodes = used_nodes + 1
        WHERE token_hash = ? AND changes() = 1
      `).bind(tokenHash),
      env.DB.prepare(`
        INSERT INTO audit_events (
          actor_type, actor_id, action, target_type, target_id, details_json
        )
        SELECT 'node', ?, 'node.enrolled', 'node', ?, ?
        WHERE changes() = 1
      `).bind(nodeId, nodeId, detailsJson)
    ]);
  } catch (error) {
    if (String(error).includes("nodes.public_key")) {
      throw new ApiError(409, "public_key_already_enrolled");
    }
    throw error;
  }

  if ((results[0]?.meta?.changes || 0) !== 1) {
    throw new ApiError(403, "enrollment_rejected");
  }

  return json({
    ok: true,
    node: { node_id: nodeId, status: "online" },
    authentication: {
      scheme: "CITADEL-Ed25519",
      required_headers: ["x-node-id", "x-node-timestamp", "x-node-signature"],
      signature_window_seconds: SIGNATURE_WINDOW_SECONDS
    }
  }, 201);
}

async function heartbeat(request, env, nodeId, url) {
  const bodyText = await readBodyText(request, MAX_NODE_BODY_BYTES);
  await authenticateNode(request, env, nodeId, url, bodyText);
  const body = parseJsonObject(bodyText);

  const cpuPercent = optionalPercent(body.cpu_percent, "cpu_percent");
  const memoryPercent = optionalPercent(body.memory_percent, "memory_percent");
  const agentVersion = optionalString(body.agent_version, "agent_version", 80);
  const capabilitiesJson = body.capabilities === undefined
    ? null
    : normalizeCapabilities(body.capabilities);
  const detailsJson = JSON.stringify({
    cpu_percent: cpuPercent,
    memory_percent: memoryPercent,
    agent_version: agentVersion
  });

  const results = await env.DB.batch([
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
  ]);

  if ((results[0]?.meta?.changes || 0) !== 1) {
    throw new ApiError(404, "node_not_found");
  }

  const node = await env.DB.prepare(
    "SELECT status, last_seen_at FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();
  return json({ ok: true, node_id: nodeId, ...node });
}

async function listAssignments(request, env, nodeId, url) {
  await authenticateNode(request, env, nodeId, url, "");

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
  return json({ ok: true, assignments });
}

async function acceptAssignment(request, env, nodeId, assignmentId, url) {
  const bodyText = await readBodyText(request, 1024);
  await authenticateNode(request, env, nodeId, url, bodyText);

  await env.DB.batch([
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
    `).bind(assignmentId, nodeId),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      )
      SELECT 'node', ?, 'assignment.accepted', 'assignment', ?, '{}'
      WHERE changes() = 1
    `).bind(nodeId, assignmentId)
  ]);

  const assignment = await env.DB.prepare(`
    SELECT assignment_id, mission_id, status, started_at, attempt_count
    FROM assignments
    WHERE assignment_id = ? AND node_id = ?
  `).bind(assignmentId, nodeId).first();

  if (!assignment) {
    throw new ApiError(404, "assignment_not_found");
  }
  if (assignment.status !== "running") {
    throw new ApiError(409, "assignment_not_active");
  }
  return json({ ok: true, assignment });
}

async function submitResult(request, env, nodeId, url) {
  const bodyText = await readBodyText(request, MAX_NODE_BODY_BYTES);
  await authenticateNode(request, env, nodeId, url, bodyText);
  const body = parseJsonObject(bodyText);

  const assignmentId = requireString(body.assignment_id, "assignment_id", 128);
  const outcome = requireString(body.outcome, "outcome", 16);
  if (!ALLOWED_OUTCOMES.has(outcome)) {
    throw new ApiError(400, "invalid_outcome");
  }

  const summary = optionalString(body.summary, "summary", 4000);
  const artifactKey = optionalString(body.artifact_key, "artifact_key", 512);
  const metricsJson = normalizeMetrics(body.metrics);

  const existing = await env.DB.prepare(`
    SELECT result_id, outcome, created_at
    FROM results
    WHERE assignment_id = ? AND node_id = ?
  `).bind(assignmentId, nodeId).first();
  if (existing) {
    return json({ ok: true, duplicate: true, result: existing });
  }

  const resultId = `result_${crypto.randomUUID()}`;
  const assignmentStatus = outcome === "failed" ? "failed" : "completed";
  const detailsJson = JSON.stringify({ result_id: resultId, outcome });

  let statements;
  try {
    statements = await env.DB.batch([
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
        UPDATE assignments
        SET status = ?,
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            completed_at = CURRENT_TIMESTAMP
        WHERE assignment_id = ? AND node_id = ? AND changes() = 1
      `).bind(assignmentStatus, assignmentId, nodeId),
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
    ]);
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
    result: { result_id: resultId, assignment_id: assignmentId, outcome }
  }, 201);
}

async function listCommands(request, env, nodeId, url) {
  await authenticateNode(request, env, nodeId, url, "");

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
  return json({ ok: true, commands });
}

async function acknowledgeCommand(request, env, nodeId, commandId, url) {
  const bodyText = await readBodyText(request, 8 * 1024);
  await authenticateNode(request, env, nodeId, url, bodyText);
  const body = parseJsonObject(bodyText);
  const status = requireString(body.status, "status", 16);
  if (!ALLOWED_COMMAND_ACKS.has(status)) {
    throw new ApiError(400, "invalid_command_status");
  }

  const detailsJson = JSON.stringify({ status });
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE commands
      SET status = ?,
          completed_at = CASE
            WHEN ? IN ('completed', 'failed') THEN CURRENT_TIMESTAMP
            ELSE completed_at
          END
      WHERE command_id = ?
        AND node_id = ?
        AND (
          (status = 'pending' AND ? IN ('accepted', 'completed', 'failed'))
          OR (status = 'accepted' AND ? IN ('completed', 'failed'))
        )
    `).bind(status, status, commandId, nodeId, status, status),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      )
      SELECT 'node', ?, 'command.acknowledged', 'command', ?, ?
      WHERE changes() = 1
    `).bind(nodeId, commandId, detailsJson)
  ]);

  const command = await env.DB.prepare(`
    SELECT command_id, command_type, status, completed_at
    FROM commands
    WHERE command_id = ? AND node_id = ?
  `).bind(commandId, nodeId).first();

  if (!command) {
    throw new ApiError(404, "command_not_found");
  }
  if (command.status !== status) {
    throw new ApiError(409, "invalid_command_transition");
  }
  return json({ ok: true, command });
}

function apiDescription() {
  return json({
    ok: true,
    service: "citadel-ai",
    api_version: "v1",
    authentication: "CITADEL-Ed25519",
    mission_types: [
      "system_inventory",
      "log_analysis",
      "config_audit",
      "dependency_audit",
      "advisory_analysis",
      "file_hashing"
    ],
    command_types: ["pause", "resume", "update", "uninstall"],
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
      return json({
        ok: row?.ok === 1,
        service: "citadel-ai",
        database: "citadel-control"
      });
    } catch {
      return json({
        ok: false,
        service: "citadel-ai",
        database: "unavailable"
      }, 503);
    }
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
