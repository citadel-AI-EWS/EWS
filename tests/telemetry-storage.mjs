import assert from "node:assert/strict";
import worker from "../src/worker.js";

const architectToken = "test-architect-token-with-enough-entropy";
const architectHash = Buffer.from(await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(architectToken)
)).toString("hex");
const nodeKeys = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"]
);
const nodePublicJwk = await crypto.subtle.exportKey("jwk", nodeKeys.publicKey);

const state = {
  node: {
    node_id: "node_telemetry_test",
    public_key: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: nodePublicJwk.x }),
    status: "online",
    agent_version: "0.3.10"
  },
  logs: [],
  rate: new Map(),
  nonces: new Set()
};

function compact(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

class Statement {
  constructor(sql) {
    this.sql = compact(sql);
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async first() {
    if (this.sql.includes("SELECT token_hash") && this.sql.includes("FROM architect_auth_state")) return { token_hash: architectHash };
    if (this.sql.includes("SELECT node_id, public_key, status, agent_version FROM nodes")) {
      return this.args[0] === state.node.node_id ? { ...state.node } : null;
    }
    if (this.sql.includes("SELECT request_count, window_started_at") && this.sql.includes("FROM node_log_rate_limits")) {
      const current = state.rate.get(this.args[0]);
      return current ? { ...current } : null;
    }
    if (this.sql.includes("COUNT(*) AS event_count") && this.sql.includes("FROM node_logs")) {
      const times = state.logs.map((item) => item.received_at).sort();
      return {
        event_count: state.logs.length,
        node_count: new Set(state.logs.map((item) => item.node_id)).size,
        oldest_received_at: times[0] || null,
        newest_received_at: times.at(-1) || null
      };
    }
    throw new Error(`Unhandled first(): ${this.sql}`);
  }
  async all() {
    if (this.sql.includes("FROM node_logs") && this.sql.includes("ORDER BY created_at DESC")) {
      const [nodeId, , level, , eventType, , cursorCreated, , , cursorEventId, limit] = this.args;
      let rows = state.logs.filter((row) =>
        (!nodeId || row.node_id === nodeId) &&
        (!level || row.level === level) &&
        (!eventType || row.event_type === eventType)
      );
      rows.sort((left, right) =>
        right.created_at.localeCompare(left.created_at) ||
        right.event_id.localeCompare(left.event_id)
      );
      if (cursorCreated) {
        rows = rows.filter((row) =>
          row.created_at < cursorCreated ||
          (row.created_at === cursorCreated && row.event_id < cursorEventId)
        );
      }
      return { results: rows.slice(0, limit).map((row) => ({ ...row })) };
    }
    if (this.sql.includes("GROUP BY node_id")) {
      const counts = new Map();
      for (const row of state.logs) {
        const current = counts.get(row.node_id) || { node_id: row.node_id, event_count: 0, newest_created_at: null };
        current.event_count += 1;
        if (!current.newest_created_at || row.created_at > current.newest_created_at) {
          current.newest_created_at = row.created_at;
        }
        counts.set(row.node_id, current);
      }
      return { results: [...counts.values()] };
    }
    throw new Error(`Unhandled all(): ${this.sql}`);
  }
  async run() {
    if (this.sql.startsWith("INSERT OR IGNORE INTO architect_auth_state")) return { meta: { changes: 0 } };
    if (this.sql.startsWith("INSERT OR IGNORE INTO node_request_nonces")) {
      const key = this.args.join(":");
      if (state.nonces.has(key)) return { meta: { changes: 0 } };
      state.nonces.add(key);
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM node_request_nonces")) return { meta: { changes: 0 } };
    if (this.sql.startsWith("CREATE TABLE") || this.sql.startsWith("CREATE INDEX")) {
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("INSERT INTO node_log_rate_limits")) {
      const nodeId = this.args[0];
      const now = Date.now();
      const current = state.rate.get(nodeId);
      if (!current || now - Date.parse(current.window_started_at) >= 5 * 60 * 1000) {
        state.rate.set(nodeId, {
          request_count: 1,
          window_started_at: new Date(now).toISOString()
        });
      } else {
        current.request_count += 1;
      }
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT OR IGNORE INTO node_logs")) {
      const [event_id, node_id, level, event_type, message, details_json, created_at] = this.args;
      if (state.logs.some((item) => item.event_id === event_id)) {
        return { meta: { changes: 0 } };
      }
      state.logs.push({
        event_id,
        node_id,
        level,
        event_type,
        message,
        details_json,
        created_at,
        received_at: new Date().toISOString()
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM node_logs") && this.sql.includes("datetime(received_at)")) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const before = state.logs.length;
      state.logs = state.logs.filter((item) => Date.parse(item.received_at) >= cutoff);
      return { meta: { changes: before - state.logs.length } };
    }
    if (this.sql.startsWith("DELETE FROM node_logs") && this.sql.includes("event_id NOT IN")) {
      const [nodeId] = this.args;
      const selected = state.logs
        .filter((item) => item.node_id === nodeId)
        .sort((left, right) =>
          right.created_at.localeCompare(left.created_at) ||
          right.event_id.localeCompare(left.event_id)
        )
        .slice(0, 5000);
      const keep = new Set(selected.map((item) => item.event_id));
      const before = state.logs.length;
      state.logs = state.logs.filter((item) => item.node_id !== nodeId || keep.has(item.event_id));
      return { meta: { changes: before - state.logs.length } };
    }
    throw new Error(`Unhandled run(): ${this.sql}`);
  }
}

const env = {
  ARCHITECT_TOKEN_HASH: architectHash,
  DB: {
    prepare(sql) {
      return new Statement(sql);
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  },
  ASSETS: { fetch() { return new Response("asset"); } }
};

async function signedPost(payload, { badSignature = false, requestId = crypto.randomUUID() } = {}) {
  const path = `/api/v1/nodes/${state.node.node_id}/logs`;
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = Buffer.from(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body)
  )).toString("hex");
  const canonical = ["POST", path, timestamp, requestId, bodyHash].join("\n");
  const signature = await crypto.subtle.sign(
    "Ed25519",
    nodeKeys.privateKey,
    new TextEncoder().encode(canonical)
  );
  const encoded = Buffer.from(signature).toString("base64url");
  return worker.fetch(new Request(`https://example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-node-id": state.node.node_id,
      "x-node-timestamp": timestamp,
      "x-node-request-id": requestId,
      "x-node-signature": badSignature ? encoded.slice(0, -2) + "aa" : encoded
    },
    body
  }), env);
}

const batch = {
  events: [
    {
      event_id: "log_evt_001",
      level: "info",
      event_type: "agent_start",
      message: "agent_start",
      created_at: "2026-09-12T20:00:00Z",
      details: { version: "0.2.0", token: "must-not-be-stored" }
    },
    {
      event_id: "log_evt_002",
      level: "warn",
      event_type: "resource_guard",
      message: "resource guard",
      created_at: "2026-09-12T20:00:01Z",
      details: { cpu_percent: 95.2 }
    }
  ]
};

const firstRequestId = crypto.randomUUID();
let response = await signedPost(batch, { requestId: firstRequestId });
assert.equal(response.status, 201);
let data = await response.json();
assert.equal(data.accepted, 2);
assert.equal(data.duplicates, 0);
assert.equal(data.rate_limit.requests, 60);
assert.equal(data.rate_limit.window_seconds, 300);
assert.equal(state.logs.length, 2);

response = await signedPost(batch, { requestId: firstRequestId });
assert.equal(response.status, 409);
assert.equal((await response.json()).error, "replayed_request");
assert.equal(state.logs.length, 2);
assert.equal(JSON.parse(state.logs[0].details_json).token, "[REDACTED]");

response = await signedPost(batch);
assert.equal(response.status, 200);
data = await response.json();
assert.equal(data.accepted, 0);
assert.equal(data.duplicates, 2);
assert.equal(state.logs.length, 2);

const unsafeDetails = JSON.parse(
  '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"api_key":"must-not-be-stored","safe":"ok"}'
);
response = await signedPost({
  events: [{
    event_id: "log_evt_unsafe_keys",
    level: "error",
    event_type: "cycle_error",
    message: "cycle_error",
    created_at: "2026-09-12T20:00:01Z",
    details: unsafeDetails
  }]
});
assert.equal(response.status, 201);
const unsafeStored = JSON.parse(
  state.logs.find((item) => item.event_id === "log_evt_unsafe_keys").details_json
);
assert.equal(Object.hasOwn(unsafeStored, "__proto__"), false);
assert.equal(Object.hasOwn(unsafeStored, "constructor"), false);
assert.equal(unsafeStored.api_key, "[REDACTED]");
assert.equal(unsafeStored.safe, "ok");
assert.equal({}.polluted, undefined);
state.logs = state.logs.filter((item) => item.event_id !== "log_evt_unsafe_keys");

response = await signedPost(batch, { badSignature: true });
assert.equal(response.status, 401);
assert.equal((await response.json()).error, "invalid_signature");

state.node.status = "revoked";
response = await signedPost({ events: [batch.events[0]] });
assert.equal(response.status, 403);
assert.equal((await response.json()).error, "node_revoked");
state.node.status = "online";

response = await signedPost({
  events: [{
    event_id: "bad_type",
    event_type: "unapproved_event",
    created_at: "2026-09-12T20:00:02Z"
  }]
});
assert.equal(response.status, 400);
assert.equal((await response.json()).error, "event_type_not_allowed");

const oversized = {
  events: [{
    event_id: "oversized",
    event_type: "cycle_error",
    created_at: "2026-09-12T20:00:02Z",
    details: { padding: "x".repeat(70 * 1024) }
  }]
};
response = await signedPost(oversized);
assert.equal(response.status, 413);
assert.equal((await response.json()).error, "request_too_large");

state.rate.clear();
for (let index = 0; index < 60; index += 1) {
  response = await signedPost(batch);
  assert.equal(response.status, 200);
}
response = await signedPost(batch);
assert.equal(response.status, 429);
assert.equal((await response.json()).error, "telemetry_rate_limited");
assert.equal(response.headers.get("retry-after"), "300");
state.rate.set(state.node.node_id, {
  request_count: 999,
  window_started_at: new Date(Date.now() - 6 * 60 * 1000).toISOString()
});
response = await signedPost(batch);
assert.equal(response.status, 200);
assert.equal(state.rate.get(state.node.node_id).request_count, 1);

response = await worker.fetch(new Request(
  "https://example.test/api/v1/architect/logs?limit=1",
  { headers: { authorization: "Bearer wrong-token" } }
), env);
assert.equal(response.status, 401);
assert.equal((await response.json()).error, "invalid_architect_token");

state.logs.push({
  event_id: "expired_event",
  node_id: state.node.node_id,
  level: "info",
  event_type: "agent_start",
  message: "expired",
  details_json: "{}",
  created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
  received_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
});

const architectHeaders = { authorization: `Bearer ${architectToken}` };
response = await worker.fetch(new Request(
  "https://example.test/api/v1/architect/logs?limit=1",
  { headers: architectHeaders }
), env);
assert.equal(response.status, 200);
data = await response.json();
assert.equal(state.logs.some((item) => item.event_id === "expired_event"), false);
assert.equal(data.logs.length, 1);
assert.equal(data.logs[0].event_id, "log_evt_002");
assert.ok(data.next_cursor);

response = await worker.fetch(new Request(
  `https://example.test/api/v1/architect/logs?limit=1&cursor=${encodeURIComponent(data.next_cursor)}`,
  { headers: architectHeaders }
), env);
assert.equal(response.status, 200);
data = await response.json();
assert.equal(data.logs.length, 1);
assert.equal(data.logs[0].event_id, "log_evt_001");
assert.equal(data.next_cursor, null);

response = await worker.fetch(new Request(
  "https://example.test/api/v1/architect/logs/stats",
  { headers: architectHeaders }
), env);
assert.equal(response.status, 200);
data = await response.json();
assert.equal(data.stats.event_count, 2);
assert.equal(data.stats.node_count, 1);
assert.equal(data.stats.retention_days, 7);
assert.equal(data.stats.per_node_event_cap, 5000);

console.log("Signed bounded telemetry ingestion, redaction, rate limiting, retention and pagination: OK");
