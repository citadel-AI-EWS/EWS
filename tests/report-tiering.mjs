import assert from "node:assert/strict";
import {
  REPORT_TIERING,
  handleReportTieringArchitectRequest,
  tierReportById
} from "../src/report_tiering.js";

const architectToken = "test-architect-token-with-enough-entropy";
const architectHash = Buffer.from(await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(architectToken)
)).toString("hex");

function reportRow(id, resultId, content) {
  const reportJson = JSON.stringify(content);
  return {
    report_id: id,
    result_id: resultId,
    assignment_id: `assignment_${id}`,
    mission_id: `mission_${id}`,
    node_id: "node_tiering_test",
    report_type: "system_inventory",
    report_json: reportJson,
    report_sha256: null,
    report_size_bytes: new TextEncoder().encode(reportJson).byteLength,
    sensitivity: "internal",
    created_at: "2026-09-12T20:00:00Z"
  };
}

const reports = new Map([
  ["report_ok", reportRow("report_ok", "result_ok", { finding: "safe" })],
  ["report_fail", reportRow("report_fail", "result_fail", { finding: "rollback" })],
  ["report_deferred", reportRow("report_deferred", "result_deferred", { finding: "d1" })]
]);
for (const report of reports.values()) {
  report.report_sha256 = Buffer.from(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(report.report_json)
  )).toString("hex");
}

const state = {
  reports,
  objects: new Map(),
  audits: [],
  results: new Map([
    ["result_ok", { result_id: "result_ok", assignment_id: "assignment_report_ok", node_id: "node_tiering_test", outcome: "success", summary: "ok", artifact_key: null, metrics_json: "{}" }],
    ["result_fail", { result_id: "result_fail", assignment_id: "assignment_report_fail", node_id: "node_tiering_test", outcome: "success", summary: "fail", artifact_key: null, metrics_json: "{}" }],
    ["result_deferred", { result_id: "result_deferred", assignment_id: "assignment_report_deferred", node_id: "node_tiering_test", outcome: "success", summary: "deferred", artifact_key: null, metrics_json: "{}" }]
  ])
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
    if (this.sql === "PRAGMA page_count") return { page_count: 10 };
    if (this.sql === "PRAGMA page_size") return { page_size: 4096 };
    if (this.sql.includes("FROM report_objects") && this.sql.includes("WHERE report_id = ?")) {
      const row = state.objects.get(this.args[0]);
      return row ? { ...row } : null;
    }
    if (this.sql.includes("FROM agent_reports") && this.sql.includes("WHERE report_id = ?") && !this.sql.includes("JOIN results")) {
      const row = state.reports.get(this.args[0]);
      return row ? { ...row } : null;
    }
    if (this.sql.includes("SELECT report_id FROM agent_reports WHERE result_id = ?")) {
      return [...state.reports.values()].find((item) => item.result_id === this.args[0]) || null;
    }
    if (this.sql.includes("FROM agent_reports AS ar") && this.sql.includes("JOIN results AS r")) {
      const id = this.args[0];
      const report = state.reports.get(id) || [...state.reports.values()].find((item) => item.result_id === id);
      if (!report) return null;
      const result = state.results.get(report.result_id);
      return {
        ...report,
        result_id: result.result_id,
        assignment_id: result.assignment_id,
        mission_id: report.mission_id,
        node_id: result.node_id,
        outcome: result.outcome,
        summary: result.summary,
        artifact_key: result.artifact_key,
        metrics_json: result.metrics_json
      };
    }
    if (this.sql.includes("COUNT(*) AS report_count") && this.sql.includes("LEFT JOIN report_objects")) {
      let logical = 0;
      let inline = 0;
      let r2 = 0;
      let tiered = 0;
      let deleted = 0;
      for (const report of state.reports.values()) {
        logical += report.report_size_bytes;
        const object = state.objects.get(report.report_id);
        if (!object) inline += report.report_size_bytes;
        else {
          tiered += 1;
          if (object.state !== "purged") r2 += object.body_size_bytes;
          if (object.state === "deleted") deleted += 1;
        }
      }
      return {
        report_count: state.reports.size,
        report_logical_bytes: logical,
        report_inline_d1_bytes: inline,
        report_r2_bytes: r2,
        tiered_report_count: tiered,
        pending_delete_count: deleted
      };
    }
    if (this.sql.includes("FROM architect_sessions")) return { session_count: 0, session_bytes: 0 };
    if (this.sql.includes("FROM node_logs")) return { telemetry_event_count: 0, telemetry_known_bytes: 0 };
    throw new Error(`Unhandled first(): ${this.sql}`);
  }
  async all() {
    if (this.sql.includes("LEFT JOIN report_objects AS ro") && this.sql.includes("ro.report_id IS NULL")) {
      const limit = this.args.at(-1);
      return {
        results: [...state.reports.values()]
          .filter((report) => !state.objects.has(report.report_id) && report.report_json !== REPORT_TIERING.sentinel)
          .slice(0, limit)
          .map((report) => ({ report_id: report.report_id }))
      };
    }
    if (this.sql.includes("FROM report_objects") && this.sql.includes("state = 'deleted'")) {
      return { results: [] };
    }
    throw new Error(`Unhandled all(): ${this.sql}`);
  }
  async run() {
    if (this.sql.startsWith("CREATE TABLE") || this.sql.startsWith("CREATE INDEX")) {
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("INSERT INTO report_storage_audit")) {
      state.audits.push({ args: [...this.args], sql: this.sql });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO report_objects")) {
      const [report_id, object_key, body_sha256, body_size_bytes] = this.args;
      if (state.objects.has(report_id)) throw new Error("duplicate report object");
      state.objects.set(report_id, {
        report_id,
        object_key,
        body_sha256,
        body_size_bytes,
        state: "active",
        migrated_at: new Date().toISOString(),
        delete_requested_at: null,
        restored_at: null,
        purged_at: null
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE agent_reports SET report_json = ?")) {
      const [sentinel, reportId, expected] = this.args;
      const report = state.reports.get(reportId);
      if (!report || report.report_json !== expected) return { meta: { changes: 0 } };
      report.report_json = sentinel;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE report_objects SET state = 'deleted'")) {
      const object = state.objects.get(this.args[0]);
      if (!object || object.state !== "active") return { meta: { changes: 0 } };
      object.state = "deleted";
      object.delete_requested_at = new Date().toISOString();
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE report_objects SET state = 'active'")) {
      const object = state.objects.get(this.args[0]);
      if (!object || object.state !== "deleted") return { meta: { changes: 0 } };
      object.state = "active";
      object.delete_requested_at = null;
      object.restored_at = new Date().toISOString();
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE report_objects SET state = 'purged'")) {
      const object = state.objects.get(this.args[0]);
      if (!object || object.state !== "deleted") return { meta: { changes: 0 } };
      object.state = "purged";
      object.purged_at = new Date().toISOString();
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled run(): ${this.sql}`);
  }
}

class FakeR2 {
  constructor() {
    this.objects = new Map();
    this.corruptReads = false;
  }
  async put(key, value, metadata) {
    this.objects.set(key, { value: String(value), metadata });
  }
  async get(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      async text() {
        return item.value + (this.corruptReads ? "corrupt" : "");
      }
    };
  }
  async delete(key) {
    this.objects.delete(key);
  }
}

const db = {
  prepare(sql) { return new Statement(sql); },
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
};

const r2 = new FakeR2();
const env = { DB: db, REPORTS: r2, ARCHITECT_TOKEN_HASH: architectHash };
const deferredEnv = { DB: db, ARCHITECT_TOKEN_HASH: architectHash };

let storage = await tierReportById(deferredEnv, "report_deferred");
assert.equal(storage.backend, "d1");
assert.equal(storage.state, "deferred");
assert.notEqual(state.reports.get("report_deferred").report_json, REPORT_TIERING.sentinel);

storage = await tierReportById(env, "report_ok");
assert.equal(storage.backend, "r2");
assert.equal(storage.state, "active");
assert.equal(state.reports.get("report_ok").report_json, REPORT_TIERING.sentinel);
assert.ok(r2.objects.has(storage.object_key));

const duplicate = await tierReportById(env, "report_ok");
assert.equal(duplicate.already_tiered, true);
assert.equal(duplicate.object_key, storage.object_key);

const headers = { authorization: `Bearer ${architectToken}` };
let response = await handleReportTieringArchitectRequest(
  new Request("https://example.test/api/v1/architect/reports/report_ok", { headers }),
  env,
  new URL("https://example.test/api/v1/architect/reports/report_ok")
);
assert.equal(response.status, 200);
let data = await response.json();
assert.equal(data.report.storage_backend, "r2");
assert.deepEqual(data.report.content, { finding: "safe" });

response = await handleReportTieringArchitectRequest(
  new Request("https://example.test/api/v1/architect/reports/report_ok", { method: "DELETE", headers }),
  env,
  new URL("https://example.test/api/v1/architect/reports/report_ok")
);
assert.equal(response.status, 202);
assert.equal(state.objects.get("report_ok").state, "deleted");
assert.ok(r2.objects.has(storage.object_key), "soft delete must keep the R2 body during the restore window");

response = await handleReportTieringArchitectRequest(
  new Request("https://example.test/api/v1/architect/reports/report_ok", { headers }),
  env,
  new URL("https://example.test/api/v1/architect/reports/report_ok")
);
assert.equal(response.status, 410);
assert.equal((await response.json()).error, "report_deleted");

response = await handleReportTieringArchitectRequest(
  new Request("https://example.test/api/v1/architect/reports/report_ok/restore", { method: "POST", headers }),
  env,
  new URL("https://example.test/api/v1/architect/reports/report_ok/restore")
);
assert.equal(response.status, 200);
assert.equal(state.objects.get("report_ok").state, "active");

r2.corruptReads = true;
let rollbackError = null;
try {
  await tierReportById(env, "report_fail");
} catch (error) {
  rollbackError = error;
}
r2.corruptReads = false;
assert.ok(rollbackError, "corrupt R2 verification must fail migration");
assert.notEqual(state.reports.get("report_fail").report_json, REPORT_TIERING.sentinel);
assert.equal(state.objects.has("report_fail"), false);
assert.equal([...r2.objects.keys()].some((key) => key.includes("report_fail")), false);

response = await handleReportTieringArchitectRequest(
  new Request("https://example.test/api/v1/architect/storage/tiering", { headers }),
  env,
  new URL("https://example.test/api/v1/architect/storage/tiering")
);
assert.equal(response.status, 200);
data = await response.json();
assert.equal(data.r2_configured, true);
assert.equal(data.reports.tiered_count, 1);
assert.equal(data.d1.source, "pragma");
assert.equal(data.d1.warning, "ok");

console.log("Fail-safe D1/R2 report tiering, rollback, delete and restore: OK");
