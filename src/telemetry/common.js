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
const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential)/i;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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

export async function authenticateArchitect(request, env) {
  const expectedHash = typeof env.ARCHITECT_TOKEN_HASH === "string"
    ? env.ARCHITECT_TOKEN_HASH.trim().toLowerCase()
    : "";
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new TelemetryError(503, "architect_auth_not_configured");
  }
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
  if (!headerNodeId || headerNodeId !== nodeId || !timestamp || !requestId || !signatureValue) {
    throw new TelemetryError(401, "node_authentication_required");
  }
  if (!/^[a-f0-9-]{36}$/.test(requestId)) {
    throw new TelemetryError(401, "invalid_request_id");
  }
  if (!/^\d{10,13}$/.test(timestamp)) {
    throw new TelemetryError(401, "invalid_timestamp");
  }
  const numericTimestamp = Number(timestamp);
  const timestampSeconds = timestamp.length === 13
    ? Math.floor(numericTimestamp / 1000)
    : numericTimestamp;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > SIGNATURE_WINDOW_SECONDS) {
    throw new TelemetryError(401, "expired_signature");
  }

  const node = await env.DB.prepare(
    "SELECT node_id, public_key, status FROM nodes WHERE node_id = ?"
  ).bind(nodeId).first();
  if (!node) throw new TelemetryError(401, "invalid_node");
  if (node.status === "revoked") throw new TelemetryError(403, "node_revoked");

  let publicJwk;
  try {
    publicJwk = JSON.parse(node.public_key);
  } catch {
    throw new TelemetryError(401, "invalid_node_key");
  }
  const bodyHash = await sha256Hex(bodyBytes);
  const canonical = [
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    timestamp,
    requestId,
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
      new TextEncoder().encode(canonical)
    );
  } catch {
    verified = false;
  }
  if (!verified) throw new TelemetryError(401, "invalid_signature");
  const nonce = await env.DB.prepare(
    "INSERT OR IGNORE INTO node_request_nonces (node_id, request_id) VALUES (?, ?)"
  ).bind(nodeId, requestId).run();
  if ((nonce?.meta?.changes || 0) !== 1) {
    throw new TelemetryError(409, "replayed_request");
  }
  await env.DB.prepare(
    "DELETE FROM node_request_nonces WHERE datetime(received_at) < datetime('now', '-10 minutes')"
  ).run();
  return node;
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
