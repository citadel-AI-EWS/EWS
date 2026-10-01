import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';

// Execute the actual production SQL, not a mock of its UPSERT/retention rules.
const db = new DatabaseSync(':memory:');
for (const name of fs.readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) {
  db.exec(fs.readFileSync('migrations/' + name, 'utf8'));
}
const operations = [];
class Statement {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return db.prepare(this.sql).get(...this.args) || null; }
  async all() { return {results: db.prepare(this.sql).all(...this.args)}; }
  async run() {
    const result = db.prepare(this.sql).run(...this.args);
    operations.push({sql: this.sql, changes: Number(result.changes)});
    return {meta: {changes: Number(result.changes)}};
  }
}
const env = {DB: {
  prepare: sql => new Statement(sql),
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}};
const nodeId = 'node_idle_test';
const keys = await crypto.subtle.generateKey({name: 'Ed25519'}, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
db.prepare(`INSERT INTO nodes (node_id, public_key, hostname, os_name, agent_version, last_seen_at)
  VALUES (?, ?, 'idle-test', 'Linux', '0.3.25', datetime('now', '-2 minutes'))`)
  .run(nodeId, JSON.stringify({kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x}));
const payload = {
  heartbeat: {cpu_percent: 1, memory_percent: 20, agent_version: '0.3.25',
    network: {lan_ipv4: '192.168.1.10', mac_addresses: ['02:00:00:00:00:01']},
    hardware: {memory_total_bytes: 8 * 1024 ** 3, cpu_logical_count: 4, gpus: []}},
  ai: {installed: false, server_running: false}
};
async function signed(pathSuffix, body, {nonce = crypto.randomUUID(), badSignature = false,
  timestamp = String(Math.floor(Date.now() / 1000))} = {}) {
  const path = `/api/v1/nodes/${nodeId}/${pathSuffix}`;
  const text = JSON.stringify(body);
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
  const signature = await crypto.subtle.sign('Ed25519', keys.privateKey,
    new TextEncoder().encode(['POST', path, timestamp, nonce, hash].join('\n')));
  const request = new Request('https://local.test' + path, {method: 'POST', body: text,
    headers: {'x-node-id': nodeId, 'x-node-timestamp': timestamp, 'x-node-request-id': nonce,
      'x-node-signature': badSignature ? 'invalid' : Buffer.from(signature).toString('base64url'),
      'cf-connecting-ip': '203.0.113.42', 'content-type': 'application/json'}});
  return worker.fetch(request, env);
}
function changesSince(start, table) {
  return operations.slice(start).filter(op => new RegExp(`(?:UPDATE|INTO) ${table}\\b`).test(op.sql))
    .reduce((sum, op) => sum + op.changes, 0);
}

const nonce = crypto.randomUUID();
let response = await signed('sync', payload, {nonce});
assert.equal(response.status, 200);
assert.deepEqual((await response.json()).assignments, []);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM node_request_nonces').get().n, 1,
  'one sync cycle must consume one nonce');
const persisted = db.prepare('SELECT last_seen_at FROM nodes WHERE node_id = ?').get(nodeId).last_seen_at;
const start = operations.length;
response = await signed('sync', payload);
assert.equal(response.status, 200);
for (const table of ['nodes', 'node_network_state', 'node_hardware_state', 'node_presence',
  'node_ai_state', 'node_ai_runtime_state']) {
  assert.equal(changesSince(start, table), 0, `identical sync must not rewrite ${table}`);
}
assert.equal(db.prepare('SELECT last_seen_at FROM nodes WHERE node_id = ?').get(nodeId).last_seen_at, persisted);

const beforeReplay = operations.length;
response = await signed('sync', payload, {nonce});
assert.equal(response.status, 409);
assert.equal((await response.json()).error, 'replayed_request');
assert.equal(changesSince(beforeReplay, 'nodes'), 0);
response = await signed('sync', payload, {badSignature: true});
assert.equal(response.status, 401);
response = await signed('sync', payload, {timestamp: String(Math.floor(Date.now() / 1000) - 601)});
assert.equal(response.status, 401);
response = await signed('sync', {heartbeat: []});
assert.equal(response.status, 400);
response = await signed('sync', {ai: []});
assert.equal(response.status, 400);

// Changed state persists immediately; liveness/metrics refresh after one minute.
response = await signed('sync', {...payload, ai: {installed: true, server_running: true, loaded_model: 'test-model'},
  heartbeat: {...payload.heartbeat, network: {lan_ipv4: '192.168.1.11'}}});
assert.equal(response.status, 200);
assert.equal(db.prepare('SELECT lan_ipv4 FROM node_network_state').get().lan_ipv4, '192.168.1.11');
assert.equal(db.prepare('SELECT loaded_model FROM node_ai_state').get().loaded_model, 'test-model');
db.prepare("UPDATE nodes SET last_seen_at = datetime('now', '-61 seconds') WHERE node_id = ?").run(nodeId);
response = await signed('sync', {heartbeat: {...payload.heartbeat, cpu_percent: 42}});
assert.equal(response.status, 200);
assert.equal(db.prepare('SELECT cpu_percent FROM nodes').get().cpu_percent, 42);
db.prepare("UPDATE node_ai_state SET updated_at = datetime('now', '-6 minutes')").run();
db.prepare("UPDATE node_ai_runtime_state SET updated_at = datetime('now', '-6 minutes')").run();
const refreshStart = operations.length;
response = await signed('sync', {ai: {installed: true, server_running: true, loaded_model: 'test-model'}});
assert.equal(response.status, 200);
assert.equal(changesSince(refreshStart, 'node_ai_state'), 1);
assert.equal(changesSince(refreshStart, 'node_ai_runtime_state'), 1);
db.prepare("UPDATE node_ai_state SET updated_at = datetime('now', '-4 minutes')").run();
response = await signed('ai-state', {installed: true, server_running: true,
  loaded_model: 'test-model', progress_phase: 'loading', progress_current: 2});
assert.equal(response.status, 200);
assert.equal((await response.json()).ai.updated_at,
  db.prepare('SELECT updated_at FROM node_ai_runtime_state').get().updated_at,
  'progress-only updates must expose the fresh runtime timestamp');
const activeAi = {installed: true, server_running: true, loaded_model: 'test-model',
  operation_id: 'command_live', progress_phase: 'loading'};
response = await signed('ai-state', activeAi);
assert.equal(response.status, 200);
db.prepare("UPDATE node_ai_runtime_state SET updated_at = datetime('now', '-70 seconds')").run();
const leaseStart = operations.length;
response = await signed('ai-state', activeAi);
assert.equal(response.status, 200);
assert.equal(changesSince(leaseStart, 'node_ai_runtime_state'), 1,
  'unchanged active operation must refresh inside its two-minute lease');

// Work and pending control are delivered through the same authenticated route.
db.exec(`INSERT INTO missions (mission_id, title, role_name, mission_type) VALUES ('m1', 'test', 'worker', 'system_inventory');
  INSERT INTO assignments (assignment_id, mission_id, node_id) VALUES ('a1', 'm1', '${nodeId}');`);
response = await signed('sync', {});
assert.equal((await response.json()).assignments[0].assignment_id, 'a1');
response = await signed('sync', {paused: true});
assert.deepEqual((await response.json()).assignments, []);
db.exec(`INSERT INTO commands (command_id, node_id, command_type, signature)
  VALUES ('c1', '${nodeId}', 'pause', 'test-signature');`);
response = await signed('sync', {});
const commandData = await response.json();
assert.equal(commandData.commands[0].command_id, 'c1');
assert.deepEqual(commandData.assignments, [], 'control commands must precede assignment reservation');
db.prepare("UPDATE nodes SET status = 'paused' WHERE node_id = ?").run(nodeId);
response = await signed('sync', payload);
assert.equal((await response.json()).node_status, 'paused');
db.prepare("UPDATE nodes SET status = 'revoked' WHERE node_id = ?").run(nodeId);
response = await signed('sync', payload);
assert.equal(response.status, 403);
db.prepare("UPDATE nodes SET status = 'online' WHERE node_id = ?").run(nodeId);
response = await signed('heartbeat', payload.heartbeat);
assert.equal(response.status, 200, 'legacy heartbeat remains supported');

// The cap is strict even with tied timestamps, duplicates and routine-only batches.
const insert = db.prepare(`INSERT INTO node_logs (event_id, node_id, level, event_type, message, created_at)
  VALUES (?, ?, 'error', 'cycle_error', 'test', '2026-09-30T12:00:00Z')`);
for (let i = 0; i < 5000; i++) insert.run('log_' + String(i).padStart(6, '0'), nodeId);
const event = {event_id: 'log_new', event_type: 'cycle_error', level: 'error', message: 'test',
  created_at: '2026-09-30T12:00:01Z'};
response = await signed('logs', {events: [event]});
assert.equal(response.status, 201);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM node_logs').get().n, 5000);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM node_logs WHERE event_id = 'log_new'").get().n, 1);
const duplicateStart = operations.length;
response = await signed('logs', {events: [event]});
assert.equal(response.status, 200);
assert.ok(!operations.slice(duplicateStart).some(op => /DELETE FROM node_logs/.test(op.sql)),
  'duplicate batch must not scan retention history');
const routineStart = operations.length;
response = await signed('logs', {events: [{...event, event_id: 'routine', event_type: 'agent_start', level: 'info'}]});
assert.equal(response.status, 200);
assert.ok(!operations.slice(routineStart).some(op => /DELETE FROM node_logs/.test(op.sql)));

// Scheduled cleanup keeps valid replay tokens and removes expired data without
// requiring a browser visit or a client-selected event ID.
const architectToken = 'local-test-architect-token';
env.ARCHITECT_TOKEN_HASH = Buffer.from(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(architectToken))).toString('hex');
db.exec(`INSERT INTO architect_projects (project_id, title, source_type, task_text, task_sha256,
    checks_json, created_at, updated_at) VALUES
  ('empty', 'empty', 'architect_manual', 'task', 'hash-empty', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('old', 'old', 'architect_manual', 'task', 'hash-old', '{}', datetime('now', '-25 hours'), datetime('now', '-25 hours'));
  INSERT INTO project_work_items (work_item_id, project_id, sequence_no, task_text, status) VALUES
    ('old-work', 'old', 1, 'task', 'planned');`);
response = await worker.fetch(new Request('https://local.test/api/v1/architect/projects',
  {headers: {authorization: 'Bearer ' + architectToken}}), env);
assert.equal(response.status, 200);
const projects = (await response.json()).projects;
assert.equal(projects.find(p => p.project_id === 'empty').work_item_count, 0);
assert.equal(projects.find(p => p.project_id === 'empty').finished_work_items, 0);
assert.equal(projects.find(p => p.project_id === 'old').work_item_count, 1);
assert.equal(db.prepare("SELECT status FROM architect_projects WHERE project_id = 'old'").get().status, 'planned',
  'reading the project list must not perform maintenance writes');
db.prepare("INSERT INTO node_request_nonces VALUES (?, 'expired', datetime('now', '-11 minutes'))").run(nodeId);
await worker.scheduled({cron: "17 * * * *"}, env);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM node_request_nonces WHERE request_id = 'expired'").get().n, 0);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM node_request_nonces WHERE request_id = ?').get(nonce).n, 1);
assert.equal(db.prepare("SELECT status FROM architect_projects WHERE project_id = 'old'").get().status, 'planned', 'scheduled maintenance must preserve the durable project queue');
assert.equal(db.prepare("SELECT status FROM project_work_items WHERE work_item_id = 'old-work'").get().status, 'planned', 'scheduled maintenance must preserve the durable project queue');

const source = fs.readFileSync('src/telemetry/common.js', 'utf8');
const cleanup = source.match(/"(DELETE FROM node_request_nonces WHERE received_at[^\"]+)"/)[1];
assert.ok(db.prepare('EXPLAIN QUERY PLAN ' + cleanup).all().every(row => !row.detail.includes('SCAN node_request_nonces')));
const latestLog = db.prepare('EXPLAIN QUERY PLAN SELECT event_type FROM node_logs WHERE node_id = ? ORDER BY datetime(created_at) DESC, event_id DESC LIMIT 1').all(nodeId);
assert.ok(latestLog.every(row => !row.detail.includes('TEMP B-TREE')), 'latest log must use normalized per-node index');
db.close();
console.log('D1 sync, replay protection, conditional writes, strict log retention and query plans: PASS');
