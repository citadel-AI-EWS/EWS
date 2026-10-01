import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { pruneExpiredD1Bookkeeping, readD1RetentionStatus } from "../src/d1-retention.js";
import { runD1Guardian } from "../src/d1-guardian.js";
import { readdirSync, readFileSync } from "node:fs";

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
const env = { DB: { prepare(sql) { return { async run() { const r = db.prepare(sql).run(); return { meta: { changes: r.changes } }; }, bind(...args) { return {
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
await assert.rejects(pruneExpiredD1Bookkeeping({ DB: { prepare() { return { async run() { throw Error('D1 write quota exceeded'); } }; } } }), /quota/);
db.close();

// Exercise the real Guardian claim, durable daily marker and public counters.
const fleet = new DatabaseSync(":memory:");
for (const path of readdirSync("migrations").filter(p => p.endsWith('.sql')).sort()) {
  fleet.exec(readFileSync('migrations/' + path, 'utf8'));
}
fleet.exec(`INSERT INTO nodes (node_id, public_key, hostname, os_name, agent_version, status)
  VALUES ('n', 'test-key', 'test-host', 'test-os', '0.3.24', 'offline');
  INSERT INTO node_request_nonces VALUES ('n', 'old', datetime('now', '-1 day'))`);
function statement(sql, args = []) {
  return { bind(...values) { return statement(sql, values); },
    async run() { const r = fleet.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    async first() { return fleet.prepare(sql).get(...args) || null; },
    async all() { return { results: fleet.prepare(sql).all(...args) }; } };
}
const fleetEnv = { DB: { prepare: statement, async batch(items) { return Promise.all(items.map(s => s.run())); } } };
const hook = { force: true, pruneExpiredD1Bookkeeping };
await runD1Guardian(fleetEnv, hook);
assert.equal((await readD1RetentionStatus(fleetEnv)).deleted_rows, 1);
fleet.exec(`INSERT INTO node_request_nonces VALUES ('n', 'later', datetime('now', '-1 day'))`);
await runD1Guardian(fleetEnv, hook);
assert.equal(fleet.prepare("SELECT COUNT(*) AS n FROM node_request_nonces").get().n, 1);
fleet.exec(`UPDATE d1_guardian_actions SET created_at = datetime('now', '-1 day') WHERE action = 'daily_bookkeeping_retention'`);
await runD1Guardian(fleetEnv, hook);
assert.equal(fleet.prepare("SELECT COUNT(*) AS n FROM node_request_nonces").get().n, 0);
assert.equal((await readD1RetentionStatus(fleetEnv)).status, 'completed');
assert.equal(fleet.prepare("SELECT COUNT(*) AS n FROM d1_guardian_actions WHERE action='daily_bookkeeping_retention'").get().n, 2);
fleet.close();
console.log("Daily D1 retention: bounded SQL deletion, replay/rate safety, idempotence and quota errors: OK");
