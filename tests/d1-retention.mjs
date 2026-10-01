import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { pruneExpiredD1Bookkeeping } from "../src/d1-retention.js";

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE node_request_nonces (node_id TEXT, request_id TEXT,
  received_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (node_id, request_id));
  CREATE INDEX idx_nonces_received ON node_request_nonces(received_at);
  CREATE TABLE node_log_rate_limits (node_id TEXT PRIMARY KEY,
    window_started_at TEXT DEFAULT CURRENT_TIMESTAMP, request_count INTEGER);
  CREATE TABLE audit_events (event_id INTEGER PRIMARY KEY, action TEXT);
  INSERT INTO audit_events VALUES (1, 'preserve');
  INSERT INTO node_request_nonces VALUES ('n', 'recent', datetime('now', '-9 minutes'));
  INSERT INTO node_request_nonces VALUES ('n', 'future', datetime('now', '+1 minute'));
  INSERT INTO node_log_rate_limits VALUES ('recent', datetime('now', '-23 hours'), 20);
  INSERT INTO node_log_rate_limits VALUES ('old', datetime('now', '-2 days'), 20);`);
const insert = db.prepare("INSERT INTO node_request_nonces VALUES ('n', ?, datetime('now', '-1 day'))");
for (let i = 0; i < 1201; i += 1) insert.run(String(i));
const env = { DB: { prepare(sql) { return { bind(...args) { return {
  async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; }
}; } }; } } };

let result = await pruneExpiredD1Bookkeeping(env);
assert.equal(result.deleted_rows, 1001);
assert.equal(result.rules[0].batch_limit_reached, true);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM node_request_nonces").get().n, 203);
result = await pruneExpiredD1Bookkeeping(env);
assert.equal(result.deleted_rows, 201);
assert.equal(result.rules[0].batch_limit_reached, false);
assert.deepEqual(db.prepare("SELECT request_id FROM node_request_nonces ORDER BY request_id").all().map(r => r.request_id), ['future', 'recent']);
assert.equal(db.prepare("SELECT node_id FROM node_log_rate_limits").get().node_id, 'recent');
assert.throws(() => db.prepare("INSERT INTO node_request_nonces VALUES ('n', 'recent', CURRENT_TIMESTAMP)").run(), /UNIQUE/);
assert.equal(db.prepare("SELECT action FROM audit_events").get().action, 'preserve');
assert.equal((await pruneExpiredD1Bookkeeping(env)).deleted_rows, 0);
db.exec("DROP TABLE node_log_rate_limits");
assert.equal((await pruneExpiredD1Bookkeeping(env)).rules[1].table_missing, true);
await assert.rejects(pruneExpiredD1Bookkeeping({ DB: { prepare() { return { bind() { return { async run() { throw Error('D1 write quota exceeded'); } }; } }; } } }), /quota/);
db.close();
console.log("Daily D1 retention: bounded SQL deletion, replay/rate safety, idempotence and quota errors: OK");
