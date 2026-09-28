import assert from "node:assert/strict";
const sourcePath = process.env.CITADEL_WORKER_SOURCE || "../src/index.js";
const worker = (await import(new URL(sourcePath, import.meta.url))).default;

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
    node_id: "node_report_test",
    public_key: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: nodePublicJwk.x }),
    status: "online",
    agent_version: "0.3.10"
  },
  result: null,
  nonces: new Set(),
  payloads: new Map(),
  drive: new Map()
};
const originalFetch = globalThis.fetch;
let driveNo = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
    driveNo += 1;
    const fileId = "drive_report_" + driveNo;
    const raw = String(init.body || "");
    const chunks = raw.split("\r\n\r\n");
    const payloadText = (chunks[2] || "").split("\r\n--")[0];
    state.drive.set(fileId, payloadText);
    return new Response(JSON.stringify({ id: fileId }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  const media = url.match(/\/drive\/v3\/files\/([^?]+)\?alt=media/);
  if (media) {
    const value = state.drive.get(decodeURIComponent(media[1]));
    return value === undefined ? new Response("missing", { status: 404 }) : new Response(value, { status: 200 });
  }
  if (url.includes("/drive/v3/files/") && init.method === "DELETE") {
    const fileId = decodeURIComponent(url.split("/").pop());
    state.drive.delete(fileId);
    return new Response(null, { status: 204 });
  }
  return originalFetch(input, init);
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
    if (this.sql.includes("SELECT node_id, public_key, status")) {
      return this.args[0] === state.node.node_id ? { ...state.node } : null;
    }
    if (this.sql.includes("SELECT result_id, outcome, created_at FROM results")) {
      return state.result;
    }
    if (this.sql.includes("FROM payload_objects WHERE payload_id = ?")) {
      return state.payloads.get(this.args[0]) || null;
    }
    if (this.sql.includes("FROM agent_reports AS ar") && this.sql.includes("WHERE ar.report_id = ?")) {
      return state.result && [state.result.report_id, state.result.result_id].includes(this.args[0])
        ? { ...state.result }
        : null;
    }
    throw new Error(`Unhandled first(): ${this.sql}`);
  }
  async all() {
    if (this.sql.includes("FROM agent_reports AS ar") && this.sql.includes("ORDER BY ar.created_at DESC")) {
      return { results: state.result ? [{ ...state.result }] : [] };
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
    if (this.sql.startsWith("INSERT OR IGNORE INTO agent_reports")) {
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("INSERT INTO payload_objects")) {
      const [payload_id, owner_type, owner_id, kind, drive_file_id, sha256, size_bytes] = this.args;
      state.payloads.set(payload_id, { payload_id, owner_type, owner_id, kind, drive_file_id, sha256, size_bytes });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM payload_objects")) {
      return { meta: { changes: state.payloads.delete(this.args[0]) ? 1 : 0 } };
    }
    if (this.sql.startsWith("INSERT INTO results")) {
      const [
        result_id,
        assignment_id,
        node_id,
        outcome,
        summary,
        artifact_key,
        metrics_json
      ] = this.args;
      state.result = {
        result_id,
        assignment_id,
        mission_id: "mission_report_test",
        node_id,
        outcome,
        summary,
        artifact_key,
        metrics_json,
        created_at: new Date().toISOString()
      };
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO agent_reports")) {
      const [
        report_id,
        report_type,
        report_json,
        report_sha256,
        report_size_bytes,
        sensitivity,
        result_id
      ] = this.args;
      assert.equal(result_id, state.result.result_id);
      Object.assign(state.result, {
        report_id,
        report_type,
        report_json,
        report_sha256,
        report_size_bytes,
        sensitivity
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("CREATE TABLE") || this.sql.startsWith("CREATE INDEX") || this.sql.startsWith("CREATE UNIQUE INDEX")) {
      return { meta: { changes: 0 } };
    }
    if (
      this.sql.startsWith("UPDATE assignments") ||
      this.sql.startsWith("UPDATE missions") ||
      this.sql.startsWith("INSERT INTO audit_events")
    ) {
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled run(): ${this.sql}`);
  }
}

const env = {
  ARCHITECT_TOKEN_HASH: architectHash,
  GOOGLE_DRIVE_ACCESS_TOKEN: "test-drive-token",
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

async function signedNodePost(path, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = crypto.randomUUID();
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

  return worker.fetch(new Request(`https://example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-node-id": state.node.node_id,
      "x-node-timestamp": timestamp,
      "x-node-request-id": requestId,
      "x-node-signature": Buffer.from(signature).toString("base64url")
    },
    body
  }), env);
}

const payload = {
  assignment_id: "assignment_report_test",
  outcome: "success",
  summary: "Safe test report",
  metrics: { files_checked: 42 },
  report_type: "system_inventory",
  sensitivity: "internal",
  report: { findings: [], evidence: { example: true } }
};
const submitResponse = await signedNodePost(
  `/api/v1/nodes/${state.node.node_id}/results`,
  payload
);
assert.equal(submitResponse.status, 201);
assert.equal((await submitResponse.json()).ok, true);
assert.equal(state.result.report_type, "system_inventory");
assert.equal(state.result.sensitivity, "internal");
assert.match(state.result.report_sha256, /^[a-f0-9]{64}$/);
assert.match(state.result.report_json, /^@drive:payload_/);
assert.equal(state.result.report_size_bytes, Buffer.byteLength(JSON.stringify(payload.report)));

const architectHeaders = { authorization: `Bearer ${architectToken}` };
const listResponse = await worker.fetch(new Request(
  "https://example.test/api/v1/architect/reports?limit=10",
  { headers: architectHeaders }
), env);
assert.equal(listResponse.status, 200);
const list = await listResponse.json();
assert.equal(list.reports.length, 1);
assert.equal("content" in list.reports[0], false);

const detailResponse = await worker.fetch(new Request(
  `https://example.test/api/v1/architect/reports/${state.result.result_id}`,
  { headers: architectHeaders }
), env);
assert.equal(detailResponse.status, 200);
const detail = await detailResponse.json();
assert.deepEqual(detail.report.content, payload.report);
assert.deepEqual(detail.report.metrics, payload.metrics);

assert.equal(detail.report.storage, "google_drive");
globalThis.fetch = originalFetch;
console.log("Authenticated Drive-backed report storage and retrieval: OK");
