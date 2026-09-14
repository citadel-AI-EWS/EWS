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
const ALLOWED_OUTCOMES = new Set(["success", "failed", "partial"]);
const ALLOWED_REPORT_SENSITIVITIES = new Set([
  "public",
  "internal",
  "confidential",
  "restricted"
]);
const ALLOWED_COMMAND_ACKS = new Set(["accepted", "completed", "failed"]);
const ALLOWED_ARCHITECT_MISSION_TYPES = new Set(["system_inventory"]);
const ALLOWED_ARCHITECT_COMMAND_TYPES = new Set(["pause", "resume", "update", "uninstall"]);
const LATEST_NODE_RELEASE = Object.freeze({
  version: "0.3.0",
  files: [
    {
      path: "citadel_node_v1.py",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/citadel_node_v1.py",
      sha256: "0d04b81ea777ef3ddcd98015f3cc350090955bf8cb0d67960ad407264855abfa"
    },
    {
      path: "citadel_node_v2.py",
      url: "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/citadel_node_v2.py",
      sha256: "765dfbe5963c6da5822ee8fb233e25c2de647ba77867d43cc8c771231f610f6a"
    }
  ]
});
const CONTROLLER_COMMAND_PUBLIC_X = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0";
let reportSchemaPromise;
let sessionSchemaPromise;

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
      `)
    ]).catch((error) => {
      reportSchemaPromise = undefined;
      throw error;
    });
  }
  await reportSchemaPromise;
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
      `)
    ]).catch((error) => {
      sessionSchemaPromise = undefined;
      throw error;
    });
  }
  await sessionSchemaPromise;
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
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
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
    `)
  ]);
}

function enrollmentResponse(nodeId, nodeNumber, status = "online", responseStatus = 201) {
  return json({
    ok: true,
    node: { node_id: nodeId, node_number: nodeNumber, status },
    authentication: {
      scheme: "CITADEL-Ed25519",
      required_headers: ["x-node-id", "x-node-timestamp", "x-node-signature"],
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

  const existing = await env.DB.prepare(`
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

  const nodeId = `node_${crypto.randomUUID()}`;
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO nodes (
          node_id, public_key, hostname, os_name, os_version,
          architecture, agent_version, status, capabilities_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?)
      `).bind(
        nodeId,
        publicKey,
        hostname,
        osName,
        osVersion,
        architecture,
        agentVersion,
        capabilitiesJson
      ),
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
  const node = await authenticateNode(request, env, nodeId, url, "");

  if (node.status === "paused") {
    return json({ ok: true, node_status: "paused", assignments: [] });
  }

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
  const bodyText = await readBodyText(request, 1024);
  const node = await authenticateNode(request, env, nodeId, url, bodyText);
  if (node.status === "paused") {
    throw new ApiError(409, "node_paused");
  }

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
  const bodyText = await readBodyText(request, MAX_RESULT_BODY_BYTES);
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
  await ensureReportStorage(env);

  const rawLimit = url.searchParams.get("limit") || "50";
  if (!/^\d{1,3}$/.test(rawLimit)) {
    throw new ApiError(400, "invalid_limit");
  }
  const limit = Number(rawLimit);
  if (limit < 1 || limit > 100) {
    throw new ApiError(400, "invalid_limit");
  }

  const nodeId = optionalString(url.searchParams.get("node_id"), "node_id", 128);
  const missionId = optionalString(url.searchParams.get("mission_id"), "mission_id", 128);
  const reportType = optionalString(url.searchParams.get("report_type"), "report_type", 64);

  const query = await env.DB.prepare(`
    SELECT
      ar.report_id,
      r.result_id,
      r.assignment_id,
      a.mission_id,
      r.node_id,
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
    JOIN assignments AS a ON a.assignment_id = r.assignment_id
    WHERE (? IS NULL OR r.node_id = ?)
      AND (? IS NULL OR a.mission_id = ?)
      AND (? IS NULL OR ar.report_type = ?)
    ORDER BY ar.created_at DESC
    LIMIT ?
  `).bind(
    nodeId,
    nodeId,
    missionId,
    missionId,
    reportType,
    reportType,
    limit
  ).all();

  return json({
    ok: true,
    reports: query.results || []
  });
}

async function architectGetReport(request, env, reportId) {
  await authenticateArchitect(request, env);
  await ensureReportStorage(env);

  const report = await env.DB.prepare(`
    SELECT
      ar.report_id,
      r.result_id,
      r.assignment_id,
      a.mission_id,
      r.node_id,
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
    JOIN assignments AS a ON a.assignment_id = r.assignment_id
    WHERE ar.report_id = ? OR r.result_id = ?
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
  if (!/^\d{1,3}$/.test(rawLimit)) {
    throw new ApiError(400, "invalid_limit");
  }
  const limit = Number(rawLimit);
  if (limit < 1 || limit > 100) {
    throw new ApiError(400, "invalid_limit");
  }

  const query = await env.DB.prepare(`
    SELECT session_id, name, schema_version, snapshot_sha256,
      snapshot_size_bytes, status, created_at, updated_at
    FROM architect_sessions
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(limit).all();

  return json({ ok: true, sessions: query.results || [] });
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
    "(SELECT COUNT(*) FROM nodes) AS nodes, " +
    "(SELECT COUNT(*) FROM missions) AS missions, " +
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
      missions: counts?.missions || 0,
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

  const result = await env.DB.prepare(`
    UPDATE architect_sessions
    SET name = COALESCE(?, name),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE session_id = ?
  `).bind(name, status, sessionId).run();
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
  await Promise.all([ensureReportStorage(env), ensureSessionStorage(env)]);
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

async function listCommands(request, env, nodeId, url) {
  const node = await authenticateNode(request, env, nodeId, url, "");

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
  const bodyText = await readBodyText(request, 8 * 1024);
  const node = await authenticateNode(request, env, nodeId, url, bodyText);
  const body = parseJsonObject(bodyText);
  const status = requireString(body.status, "status", 16);
  if (!ALLOWED_COMMAND_ACKS.has(status)) {
    throw new ApiError(400, "invalid_command_status");
  }

  const current = await env.DB.prepare(`
    SELECT command_id, command_type, status
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
    ? { pause: "paused", resume: "online", uninstall: "revoked" }[current.command_type]
    : null;
  if (nodeStatus) {
    statements.push(env.DB.prepare(`
      UPDATE nodes
      SET status = ?, last_seen_at = CURRENT_TIMESTAMP
      WHERE node_id = ?
    `).bind(nodeStatus, nodeId));
  }

  const results = await env.DB.batch(statements);
  if ((results[0]?.meta?.changes || 0) !== 1) {
    throw new ApiError(409, "invalid_command_transition");
  }

  const command = await env.DB.prepare(`
    SELECT command_id, command_type, status, completed_at
    FROM commands
    WHERE command_id = ? AND node_id = ?
  `).bind(commandId, nodeId).first();

  return json({ ok: true, command, node_status: nodeStatus || node.status });
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

async function authenticateArchitect(request, env) {
  const expectedHash = typeof env.ARCHITECT_TOKEN_HASH === "string"
    ? env.ARCHITECT_TOKEN_HASH.trim().toLowerCase()
    : "";
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new ApiError(503, "architect_auth_not_configured");
  }

  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || "";
  if (!token || token.length > 512) {
    throw new ApiError(401, "architect_authentication_required");
  }

  const actualHash = await sha256Hex(token);
  if (!constantTimeHexEqual(actualHash, expectedHash)) {
    throw new ApiError(401, "invalid_architect_token");
  }
}

async function architectOverview(request, env) {
  await authenticateArchitect(request, env);
  await Promise.all([ensureReportStorage(env), ensureSessionStorage(env)]);

  const [counts, nodesQuery, missionsQuery, commandsQuery, auditQuery] = await Promise.all([
    env.DB.prepare(
      "SELECT " +
      "(SELECT COUNT(*) FROM nodes) AS nodes, " +
      "(SELECT COUNT(*) FROM nodes WHERE status = 'online') AS online_nodes, " +
      "(SELECT COUNT(*) FROM missions) AS missions, " +
      "(SELECT COUNT(*) FROM agent_reports) AS reports, " +
      "(SELECT COUNT(*) FROM architect_sessions) AS sessions"
    ).first(),
    env.DB.prepare(
      "SELECT node_id, hostname, os_name, os_version, architecture, " +
      "agent_version, status, cpu_percent, memory_percent, " +
      "enrolled_at, last_seen_at FROM nodes " +
      "ORDER BY last_seen_at DESC LIMIT 100"
    ).all(),
    env.DB.prepare(
      "SELECT m.mission_id, m.title, m.mission_type, m.status, " +
      "m.priority, m.created_at, m.expires_at, a.assignment_id, " +
      "a.node_id, a.status AS assignment_status, r.result_id, " +
      "r.outcome, r.summary, r.metrics_json, " +
      "r.created_at AS result_created_at FROM missions AS m " +
      "LEFT JOIN assignments AS a ON a.mission_id = m.mission_id " +
      "LEFT JOIN results AS r ON r.assignment_id = a.assignment_id " +
      "ORDER BY m.created_at DESC LIMIT 100"
    ).all(),
    env.DB.prepare(
      "SELECT command_id, node_id, command_type, status, created_at, completed_at " +
      "FROM commands ORDER BY created_at DESC LIMIT 50"
    ).all(),
    env.DB.prepare(
      "SELECT event_id, actor_type, actor_id, action, target_type, " +
      "target_id, created_at FROM audit_events " +
      "ORDER BY event_id DESC LIMIT 30"
    ).all()
  ]);

  const missions = (missionsQuery.results || []).map((row) => ({
    ...row,
    metrics: safeJson(row.metrics_json, {}),
    metrics_json: undefined
  }));

  return json({
    ok: true,
    counts: {
      nodes: counts?.nodes || 0,
      online_nodes: counts?.online_nodes || 0,
      missions: counts?.missions || 0,
      reports: counts?.reports || 0,
      sessions: counts?.sessions || 0
    },
    nodes: nodesQuery.results || [],
    missions,
    commands: commandsQuery.results || [],
    audit_events: auditQuery.results || []
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
  return json({ ok: true, release: LATEST_NODE_RELEASE });
}

async function architectCreateCommand(request, env, nodeId) {
  await authenticateArchitect(request, env);
  const bodyText = await readBodyText(request, 8 * 1024);
  const body = parseJsonObject(bodyText);
  const commandType = requireString(body.command_type, "command_type", 32);
  if (!ALLOWED_ARCHITECT_COMMAND_TYPES.has(commandType)) {
    throw new ApiError(400, "command_type_not_allowed");
  }

  const node = await env.DB.prepare(
    "SELECT node_id, status FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();
  if (!node) {
    throw new ApiError(404, "node_not_found");
  }
  if (node.status === "revoked") {
    throw new ApiError(409, "node_revoked");
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
  const payload = commandType === "update" ? LATEST_NODE_RELEASE : {};
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

async function architectCreateMission(request, env) {
  await authenticateArchitect(request, env);
  const bodyText = await readBodyText(request, 8 * 1024);
  const body = parseJsonObject(bodyText);

  const nodeId = requireString(body.node_id, "node_id", 128);
  const title = requireString(body.title, "title", 160);
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
    "SELECT node_id, status FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();
  if (!node) {
    throw new ApiError(404, "node_not_found");
  }
  if (node.status === "revoked") {
    throw new ApiError(409, "node_revoked");
  }

  const missionId = "mission_" + crypto.randomUUID();
  const assignmentId = "assignment_" + crypto.randomUUID();
  const payloadJson = JSON.stringify({
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
