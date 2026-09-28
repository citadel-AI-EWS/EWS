import assert from "node:assert/strict";
const sourcePath = process.env.CITADEL_WORKER_SOURCE || "../src/index.js";
const worker = (await import(new URL(sourcePath, import.meta.url))).default;

const architectToken = "test-architect-token-with-enough-entropy";
const architectHash = Buffer.from(await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(architectToken)
)).toString("hex");
const sessions = new Map();
const audit = [];
const payloads = new Map();
const drive = new Map();
const originalFetch = globalThis.fetch;
let driveNo = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
    driveNo += 1;
    const fileId = "drive_session_" + driveNo;
    const raw = String(init.body || "");
    const chunks = raw.split("\r\n\r\n");
    const payloadText = (chunks[2] || "").split("\r\n--")[0];
    drive.set(fileId, payloadText);
    return new Response(JSON.stringify({ id: fileId }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  const media = url.match(/\/drive\/v3\/files\/([^?]+)\?alt=media/);
  if (media) {
    const value = drive.get(decodeURIComponent(media[1]));
    return value === undefined ? new Response("missing", { status: 404 }) : new Response(value, { status: 200 });
  }
  if (url.includes("/drive/v3/files/") && init.method === "DELETE") {
    drive.delete(decodeURIComponent(url.split("/").pop()));
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
    if (this.sql.includes("AS nodes") && this.sql.includes("AS results")) {
      return { nodes: 1, active_missions: 2, results: 3, reports: 4 };
    }
    if (this.sql.includes("AS report_count") && this.sql.includes("AS payload_object_count")) {
      return {
        report_count: 4,
        report_payload_bytes: 4096,
        session_count: sessions.size,
        session_payload_bytes: [...sessions.values()].reduce(
          (total, session) => total + session.snapshot_size_bytes,
          0
        ),
        payload_object_count: payloads.size,
        drive_payload_bytes: [...payloads.values()].reduce((total, item) => total + Number(item.size_bytes || 0), 0),
        interactive_thread_count: 0,
        interactive_message_count: 0
      };
    }
    if (this.sql.includes("FROM payload_objects WHERE payload_id = ?")) {
      return payloads.get(this.args[0]) || null;
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
    if (this.sql.startsWith("INSERT OR IGNORE INTO architect_auth_state")) return { meta: { changes: 0 } };
    if (this.sql.startsWith("INSERT OR IGNORE INTO agent_reports")) {
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("CREATE TABLE") || this.sql.startsWith("CREATE INDEX") || this.sql.startsWith("CREATE UNIQUE INDEX")) {
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("INSERT INTO payload_objects")) {
      const [payload_id, owner_type, owner_id, kind, drive_file_id, sha256, size_bytes] = this.args;
      payloads.set(payload_id, { payload_id, owner_type, owner_id, kind, drive_file_id, sha256, size_bytes });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM payload_objects")) {
      return { meta: { changes: payloads.delete(this.args[0]) ? 1 : 0 } };
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
assert.match(stored.snapshot_json, /^@drive:payload_/);

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
assert.equal(usage.report_payload_bytes, 4096);
assert.equal(usage.session_count, 1);
assert.equal(usage.payload_object_count, 1);
assert.equal(usage.payload_provider, "google_drive");
assert.equal(usage.safe_d1_target_bytes, 400 * 1024 * 1024);

const deleteResponse = await request(`/api/v1/architect/sessions/${created.session_id}`, {
  method: "DELETE"
});
assert.equal(deleteResponse.status, 200);
assert.equal(sessions.size, 0);
assert.equal(audit.length, 3);
assert.equal(payloads.size, 0);
globalThis.fetch = originalFetch;

console.log("Authenticated Drive-backed session checkpoints and storage usage: OK");
