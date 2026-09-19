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
    if (this.sql.includes("SELECT node_id, public_key, status")) {
      return this.args[0] === state.node.node_id ? { ...state.node } : null;
    }
    if (this.sql.includes("SELECT result_id, outcome, created_at FROM results")) {
      return state.result;
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
    if (this.sql.startsWith("CREATE TABLE") || this.sql.startsWith("CREATE INDEX")) {
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
assert.equal(state.result.report_size_bytes, Buffer.byteLength(state.result.report_json));

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

console.log("Authenticated D1 report storage and retrieval: OK");
