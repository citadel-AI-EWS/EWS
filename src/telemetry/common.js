import {replayFailureCode} from '../replay-diagnostics.js';

export const TELEMETRY_LIMITS = Object.freeze({
  request_bytes: 64 * 1024,
  batch_events: 50,
  event_bytes: 2 * 1024,
  retention_days: 7,
  per_node_events: 5000,
  page_size: 100,
  rate_window_seconds: 5 * 60,
  requests_per_window: 60
});

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};
const SIGNATURE_WINDOW_SECONDS = 300;
const DURABLE_REPLAY_EXTRA_SECONDS = 30;

async function claimDurableReplayNonce(env, nodeId, requestId, timestampSeconds) {
  if (!env.SSH_RELAY) return null;
  try {
    try {
      const previous = await env.DB.prepare(
        "SELECT 1 AS used FROM node_request_nonces WHERE node_id = ? AND request_id = ?"
      ).bind(nodeId, requestId).first();
      if (previous) return false;
    } catch (error) {
      if (!/no such table:\s*node_request_nonces/i.test(String(error?.message || error))) throw error;
    }
    const stub = env.SSH_RELAY.get(env.SSH_RELAY.idFromName(nodeId));
    const expires = Math.max(Math.floor(Date.now() / 1000) + SIGNATURE_WINDOW_SECONDS + DURABLE_REPLAY_EXTRA_SECONDS,
      timestampSeconds + SIGNATURE_WINDOW_SECONDS + 1);
    const response = await stub.fetch("https://relay.internal/replay-claim", {
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
    // A lost DO response may follow a committed claim. An independent D1
    // fallback cannot safely determine whether that request was already used.
  }
  throw new TelemetryError(503, "node_replay_store_unavailable");
}

const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential)/i;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
let architectAuthSchemaPromise;
let nodeRequestNonceSchemaPromise;

function agentRequiresRequestId(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  return major > 0 || minor > 3 || (minor === 3 && patch >= 10);
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

export class TelemetryError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

export function methodNotAllowed(methods) {
  return json(
    { ok: false, error: "method_not_allowed" },
    405,
    { allow: methods.join(", ") }
  );
}

export function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

export function requireString(value, field, maxLength) {
  if (typeof value !== "string") {
    throw new TelemetryError(400, `invalid_${field}`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TelemetryError(400, `invalid_${field}`);
  }
  return normalized;
}

export function optionalString(value, field, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, field, maxLength);
}

export async function readBody(request, maxBytes) {
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null && rawLength !== "") {
    if (!/^\d+$/.test(rawLength)) {
      throw new TelemetryError(400, "invalid_content_length");
    }
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      throw new TelemetryError(413, "request_too_large");
    }
  }
  if (!request.body) return { bytes: new Uint8Array(0), text: "" };

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
        throw new TelemetryError(413, "request_too_large");
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
    throw new TelemetryError(400, "invalid_utf8");
  }
  return { bytes, text };
}

export async function readBodyText(request, maxBytes) {
  return (await readBody(request, maxBytes)).text;
}

export function parseJsonObject(text) {
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new TelemetryError(400, "invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TelemetryError(400, "json_object_required");
  }
  return value;
}

export function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(digest);
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TelemetryError(401, "invalid_signature");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let decoded;
  try {
    decoded = atob(padded);
  } catch {
    throw new TelemetryError(401, "invalid_signature");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function constantTimeHexEqual(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    left.length !== 64 ||
    right.length !== 64
  ) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function telemetryD1ErrorCode(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("daily row read limit")) return "architect_d1_daily_read_limit_exceeded";
  if (message.includes("daily row write limit")) return "architect_d1_daily_write_limit_exceeded";
  if (message.includes("exceeded maximum db size")) return "architect_d1_database_size_exceeded";
  if (message.includes("overloaded") || message.includes("too many api requests")) {
    return "architect_d1_overloaded";
  }
  if (message.includes("d1") || message.includes("sqlite")) return "architect_d1_error";
  return null;
}

async function readArchitectExpectedHash(env) {
  const row = await env.DB.prepare(
    "SELECT token_hash FROM architect_auth_state WHERE singleton_id = 1"
  ).first();
  return String(row?.token_hash || "").trim().toLowerCase();
}

async function bootstrapArchitectAuthState(env, bootstrapHash) {
  if (!architectAuthSchemaPromise) {
    architectAuthSchemaPromise = env.DB.prepare(`
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
    `).run().catch((error) => {
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

async function architectExpectedHash(env) {
  const bootstrapHash = typeof env.ARCHITECT_TOKEN_HASH === "string"
    ? env.ARCHITECT_TOKEN_HASH.trim().toLowerCase()
    : "";
  if (!/^[a-f0-9]{64}$/.test(bootstrapHash)) {
    throw new TelemetryError(503, "architect_auth_not_configured");
  }

  let activeHash = "";
  try {
    activeHash = await readArchitectExpectedHash(env);
  } catch (error) {
    if (!/no such table:\s*architect_auth_state/i.test(String(error?.message || error || ""))) {
      const code = telemetryD1ErrorCode(error);
      if (code) throw new TelemetryError(503, code);
      throw error;
    }
  }

  if (!activeHash) {
    try {
      await bootstrapArchitectAuthState(env, bootstrapHash);
      activeHash = await readArchitectExpectedHash(env);
    } catch (error) {
      const code = telemetryD1ErrorCode(error);
      if (code) throw new TelemetryError(503, code);
      throw error;
    }
  }

  if (!/^[a-f0-9]{64}$/.test(activeHash)) {
    throw new TelemetryError(503, "architect_auth_not_configured");
  }
  return activeHash;
}

export async function authenticateArchitect(request, env) {
  const expectedHash = await architectExpectedHash(env);
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || "";
  if (!token || token.length > 512) {
    throw new TelemetryError(401, "architect_authentication_required");
  }
  const actualHash = await sha256Hex(token);
  if (!constantTimeHexEqual(actualHash, expectedHash)) {
    throw new TelemetryError(401, "invalid_architect_token");
  }
}

export async function authenticateNode(request, env, nodeId, url, bodyBytes) {
  const headerNodeId = request.headers.get("x-node-id");
  const timestamp = request.headers.get("x-node-timestamp");
  const requestId = request.headers.get("x-node-request-id");
  const signatureValue = request.headers.get("x-node-signature");
  if (!headerNodeId || headerNodeId !== nodeId || !timestamp || !signatureValue) {
    throw new TelemetryError(401, "node_authentication_required");
  }
  if (!/^\d{10,13}$/.test(timestamp)) {
    throw new TelemetryError(401, "invalid_timestamp");
  }
  if (requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
    throw new TelemetryError(401, "invalid_request_id");
  }
  const numericTimestamp = Number(timestamp);
  const timestampSeconds = timestamp.length === 13
    ? Math.floor(numericTimestamp / 1000)
    : numericTimestamp;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > SIGNATURE_WINDOW_SECONDS) {
    throw new TelemetryError(401, "expired_signature");
  }

  const node = await env.DB.prepare(
    "SELECT node_id, public_key, status, agent_version FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();
  if (!node) throw new TelemetryError(401, "invalid_node");
  if (node.status === "revoked") throw new TelemetryError(403, "node_revoked");

  const replayProtected = agentRequiresRequestId(node.agent_version);
  if (replayProtected && !requestId) {
    throw new TelemetryError(401, "request_id_required");
  }

  let publicJwk;
  try {
    publicJwk = JSON.parse(node.public_key);
  } catch {
    throw new TelemetryError(401, "invalid_node_key");
  }
  const bodyHash = await sha256Hex(bodyBytes);
  const canonicalParts = [
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    timestamp
  ];
  if (requestId) canonicalParts.push(requestId);
  canonicalParts.push(bodyHash);
  const canonical = canonicalParts.join("\n");

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
      new TextEncoder().encode(canonical)
    );
  } catch {
    verified = false;
  }
  if (!verified) throw new TelemetryError(401, "invalid_signature");

  if (requestId) {
    // Use the per-node Durable Object as the primary atomic replay store for
    // every signed modern node request. Only deployments without a DO binding
    // use D1; a configured DO outage fails closed without changing replay stores.
    const durableClaim = await claimDurableReplayNonce(env, nodeId, requestId, timestampSeconds);
    if (durableClaim === false) {
      throw new TelemetryError(409, "replayed_request");
    }
    if (durableClaim !== true) {
      await ensureNodeRequestNonceStorage(env);
      const nonce = await env.DB.prepare(
        "INSERT OR IGNORE INTO node_request_nonces (node_id, request_id) VALUES (?, ?)"
      ).bind(nodeId, requestId).run();
      if ((nonce?.meta?.changes || 0) !== 1) {
        throw new TelemetryError(409, "replayed_request");
      }
      if (requestId.endsWith("0")) await pruneNodeRequestNonces(env);
    }
  }
  return node;
}

export async function pruneNodeRequestNonces(env) {
  await ensureNodeRequestNonceStorage(env);
  await env.DB.prepare(
    "DELETE FROM node_request_nonces WHERE received_at < datetime('now', '-10 minutes')"
  ).run();
}

function redactString(value) {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 512);
}

export function sanitizeTelemetryValue(value, depth = 0) {
  if (depth > 4) return "[TRUNCATED_DEPTH]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => sanitizeTelemetryValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const output = Object.create(null);
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (count >= 40) break;
      const safeKey = String(key).slice(0, 80);
      if (UNSAFE_OBJECT_KEYS.has(safeKey)) continue;
      output[safeKey] = SECRET_KEY.test(safeKey)
        ? "[REDACTED]"
        : sanitizeTelemetryValue(item, depth + 1);
      count += 1;
    }
    return output;
  }
  return String(value).slice(0, 128);
}
