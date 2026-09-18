import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourcePath = process.env.CITADEL_WORKER_SOURCE || "../src/index.js";
const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;

const architectToken = "test-architect-token-with-enough-entropy";
const architectHash = Buffer.from(await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(architectToken)
)).toString("hex");
const sessions = new Map();
const audit = [];

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
    if (this.sql.includes("AS nodes") && this.sql.includes("AS results")) {
      return { nodes: 1, active_missions: 2, results: 3, reports: 4 };
    }
    if (this.sql.includes("AS report_count") && this.sql.includes("AS session_count")) {
      return {
        report_count: 4,
        report_bytes: 4096,
        session_count: sessions.size,
        session_bytes: [...sessions.values()].reduce(
          (total, session) => total + session.snapshot_size_bytes,
          0
        )
      };
    }
    if (this.sql.includes("FROM architect_sessions") && this.sql.includes("WHERE session_id = ?")) {
      const session = sessions.get(this.args[0]);
      if (!session) return null;
      if (this.sql.startsWith("SELECT session_id, name FROM")) {
        return { session_id: session.session_id, name: session.name };
      }
      return { ...session };
    }
    throw new Error(`Unhandled first(): ${this.sql}`);
  }
  async all() {
    if (this.sql.includes("FROM architect_sessions") && this.sql.includes("ORDER BY updated_at DESC")) {
      return {
        results: [...sessions.values()].map(({ snapshot_json, ...metadata }) => metadata)
      };
    }
    throw new Error(`Unhandled all(): ${this.sql}`);
  }
  async run() {
    if (this.sql.startsWith("INSERT OR IGNORE INTO agent_reports")) {
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("CREATE TABLE") || this.sql.startsWith("CREATE INDEX")) {
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("INSERT INTO architect_sessions")) {
      const [
        session_id,
        name,
        snapshot_json,
        snapshot_sha256,
        snapshot_size_bytes,
        created_at,
        updated_at
      ] = this.args;
      sessions.set(session_id, {
        session_id,
        name,
        schema_version: 1,
        snapshot_json,
        snapshot_sha256,
        snapshot_size_bytes,
        status: "active",
        created_at,
        updated_at
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE architect_sessions")) {
      const [name, status, updatedAt, sessionId] = this.args;
      const session = sessions.get(sessionId);
      if (!session) return { meta: { changes: 0 } };
      if (name !== null) session.name = name;
      if (status !== null) session.status = status;
      session.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM architect_sessions")) {
      return { meta: { changes: sessions.delete(this.args[0]) ? 1 : 0 } };
    }
    if (this.sql.startsWith("INSERT INTO audit_events")) {
      audit.push({ target_id: this.args[0], details_json: this.args[1] });
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

const headers = {
  authorization: `Bearer ${architectToken}`,
  "content-type": "application/json"
};
const request = (path, options = {}) => worker.fetch(
  new Request(`https://example.test${path}`, { headers, ...options }),
  env
);

const createResponse = await request("/api/v1/architect/sessions", {
  method: "POST",
  body: JSON.stringify({
    name: "Checkpoint 1",
    ui_state: {
      selected_node_id: "node_example",
      selected_report_id: "report_example",
      secret: "must-not-be-stored"
    }
  })
});
assert.equal(createResponse.status, 201);
const created = (await createResponse.json()).session;
assert.match(created.session_id, /^session_/);
assert.match(created.snapshot_sha256, /^[a-f0-9]{64}$/);

const stored = sessions.get(created.session_id);
const snapshot = JSON.parse(stored.snapshot_json);
assert.deepEqual(snapshot.counts, { nodes: 1, missions: 2, active_missions: 2, results: 3, reports: 4 });
assert.equal(snapshot.ui_state.selected_node_id, "node_example");
assert.equal("secret" in snapshot.ui_state, false);

const listResponse = await request("/api/v1/architect/sessions?limit=10");
assert.equal(listResponse.status, 200);
const listed = (await listResponse.json()).sessions;
assert.equal(listed.length, 1);
assert.equal("snapshot" in listed[0], false);
assert.equal("snapshot_json" in listed[0], false);

const detailResponse = await request(`/api/v1/architect/sessions/${created.session_id}`);
assert.equal(detailResponse.status, 200);
const detail = (await detailResponse.json()).session;
assert.equal(detail.snapshot.ui_state.selected_report_id, "report_example");
assert.equal("snapshot_json" in detail, false);

const archiveResponse = await request(`/api/v1/architect/sessions/${created.session_id}`, {
  method: "PATCH",
  body: JSON.stringify({ status: "archived" })
});
assert.equal(archiveResponse.status, 200);
assert.equal((await archiveResponse.json()).session.status, "archived");

const usageResponse = await request("/api/v1/architect/storage");
assert.equal(usageResponse.status, 200);
const usage = (await usageResponse.json()).usage;
assert.equal(usage.report_bytes, 4096);
assert.equal(usage.session_count, 1);
assert.equal(usage.safe_d1_target_bytes, 400 * 1024 * 1024);

const deleteResponse = await request(`/api/v1/architect/sessions/${created.session_id}`, {
  method: "DELETE"
});
assert.equal(deleteResponse.status, 200);
assert.equal(sessions.size, 0);
assert.equal(audit.length, 3);

console.log("Authenticated session checkpoints and storage usage: OK");
