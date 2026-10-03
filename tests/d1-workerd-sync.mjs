import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

// The real Worker runtime and local D1 binding; no remote resource is configured.
const bundle = await build({stdin: {resolveDir: process.cwd(), contents: `
  import worker from './src/worker.js';
  export {NodeSshRelay} from './src/worker.js';
  export default {async fetch(request, env, ctx) {
    let writes = 0;
    const record = result => {writes += Number(result?.meta?.rows_written || 0); return result;};
    class Statement {
      constructor(inner) {this.inner = inner;}
      bind(...args) {return new Statement(this.inner.bind(...args));}
      async first(...args) {return this.inner.first(...args);}
      async all(...args) {return record(await this.inner.all(...args));}
      async run(...args) {return record(await this.inner.run(...args));}
    }
    const DB = {prepare: sql => new Statement(env.DB.prepare(sql)),
      batch: async statements => (await env.DB.batch(statements.map(s => s.inner))).map(record)};
    const response = await worker.fetch(request, {...env, DB}, ctx);
    const output = new Response(response.body, response);
    output.headers.set('x-test-d1-writes', String(writes));
    return output;
  }};
`}, bundle: true, format: 'esm', write: false});
const mf = new Miniflare(convertV4MiniflareOptions({modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-09-05', d1Databases: ['DB'],
  durableObjects: {SSH_RELAY: {className: 'NodeSshRelay', useSQLite: true}}}));
try {
  const db = await mf.getD1Database('DB');
  for (const file of fs.readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync('migrations/' + file, 'utf8').replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  const keys = await crypto.subtle.generateKey({name: 'Ed25519'}, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const nodeId = 'node_workerd_test';
  await db.prepare(`INSERT INTO nodes (node_id, public_key, hostname, os_name, agent_version)
    VALUES (?, ?, 'workerd-test', 'Linux', '0.3.24')`).bind(nodeId, JSON.stringify({kty: jwk.kty, crv: jwk.crv, x: jwk.x})).run();
  // A legacy relative timestamp is legal table data, but datetime(created_at)
  // in an expression index is non-deterministic for this row. Core telemetry
  // readiness must survive it without rewriting or deleting historical logs.
  await db.prepare(`INSERT INTO node_logs (event_id, node_id, level, event_type, message, created_at)
    VALUES ('legacy_relative_time', ?, 'info', 'agent_start', 'legacy log', 'now')`).bind(nodeId).run();
  const healthResponse = await mf.dispatchFetch('https://local.test/api/health');
  assert.equal((await healthResponse.json()).telemetry_storage, 'ready');
  assert.equal((await db.prepare("SELECT created_at FROM node_logs WHERE event_id = 'legacy_relative_time'").first()).created_at, 'now');
  const route = `/api/v1/nodes/${nodeId}/sync`;
  const body = JSON.stringify({heartbeat: {agent_version: '0.3.24', cpu_percent: 2, memory_percent: 20,
    ssh: {ssh_client_available: true, sshd_listening_local: true}},
    ai: {installed: false, server_running: false}});
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))).toString('hex');
  const sig = await crypto.subtle.sign('Ed25519', keys.privateKey,
    new TextEncoder().encode(['POST', route, timestamp, nonce, hash].join('\n')));
  const options = {method: 'POST', body, headers: {'content-type': 'application/json',
    'x-node-id': nodeId, 'x-node-timestamp': timestamp, 'x-node-request-id': nonce,
    'x-node-signature': Buffer.from(sig).toString('base64url')}};
  let response = await mf.dispatchFetch('https://local.test' + route, options);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.deepEqual((await response.json()).assignments, []);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM node_request_nonces').first()).n, 0);
  response = await mf.dispatchFetch('https://local.test' + route, options);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'replayed_request');
  // Non-sync Controller routes must use the same Durable Object replay claim.
  // This is the hot-path regression that prevents ordinary signed GET/POST traffic
  // from rebuilding the D1 nonce write amplification removed from /sync.
  const assignmentRoute = `/api/v1/nodes/${nodeId}/assignments`;
  const assignmentNonce = crypto.randomUUID();
  const emptyHash = Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array())).toString('hex');
  const assignmentSignature = await crypto.subtle.sign('Ed25519', keys.privateKey,
    new TextEncoder().encode(['GET', assignmentRoute, timestamp, assignmentNonce, emptyHash].join('\n')));
  const assignmentOptions = {method: 'GET', headers: {
    'x-node-id': nodeId, 'x-node-timestamp': timestamp, 'x-node-request-id': assignmentNonce,
    'x-node-signature': Buffer.from(assignmentSignature).toString('base64url')}};
  response = await mf.dispatchFetch('https://local.test' + assignmentRoute, assignmentOptions);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM node_request_nonces').first()).n, 0,
    'non-sync Controller request must not persist a D1 replay nonce when the Durable Object is healthy');
  response = await mf.dispatchFetch('https://local.test' + assignmentRoute, assignmentOptions);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'replayed_request');

  // Telemetry uses a separate authentication module; guard that path independently.
  const logsRoute = `/api/v1/nodes/${nodeId}/logs`;
  const logsNonce = crypto.randomUUID();
  const logsBody = JSON.stringify({events: [{
    event_id: 'workerd_durable_replay_log',
    level: 'info',
    event_type: 'command_completed',
    message: 'durable replay test',
    created_at: new Date().toISOString()
  }]});
  const logsHash = Buffer.from(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(logsBody))).toString('hex');
  const logsSignature = await crypto.subtle.sign('Ed25519', keys.privateKey,
    new TextEncoder().encode(['POST', logsRoute, timestamp, logsNonce, logsHash].join('\n')));
  const logsOptions = {method: 'POST', body: logsBody, headers: {'content-type': 'application/json',
    'x-node-id': nodeId, 'x-node-timestamp': timestamp, 'x-node-request-id': logsNonce,
    'x-node-signature': Buffer.from(logsSignature).toString('base64url')}};
  response = await mf.dispatchFetch('https://local.test' + logsRoute, logsOptions);
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM node_request_nonces').first()).n, 0,
    'telemetry request must not persist a D1 replay nonce when the Durable Object is healthy');
  response = await mf.dispatchFetch('https://local.test' + logsRoute, logsOptions);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'replayed_request');

  async function postSignedLog(body, requestId) {
    const bodyHash = Buffer.from(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(body))).toString('hex');
    const signature = await crypto.subtle.sign('Ed25519', keys.privateKey,
      new TextEncoder().encode(['POST', logsRoute, timestamp, requestId, bodyHash].join('\n')));
    return mf.dispatchFetch('https://local.test' + logsRoute, {method: 'POST', body,
      headers: {'content-type': 'application/json', 'x-node-id': nodeId,
        'x-node-timestamp': timestamp, 'x-node-request-id': requestId,
        'x-node-signature': Buffer.from(signature).toString('base64url')}});
  }
  const repeatedError = (eventId, createdAt) => JSON.stringify({events: [{
    event_id: eventId,
    level: 'error',
    event_type: 'cycle_error',
    message: 'cycle_error',
    details: {error: 'd1_write_limit'},
    created_at: createdAt
  }]});
  response = await postSignedLog(repeatedError('workerd_cycle_error_1',
    '2026-10-03T12:00:00Z'), crypto.randomUUID());
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await response.json()).coalesced, 0);
  response = await postSignedLog(repeatedError('workerd_cycle_error_2',
    '2026-10-03T12:00:01Z'), crypto.randomUUID());
  assert.equal(response.status, 200, await response.clone().text());
  const coalescedBody = await response.json();
  assert.equal(coalescedBody.accepted, 0);
  assert.equal(coalescedBody.coalesced, 1);
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS n FROM node_logs WHERE event_type = 'cycle_error'"
  ).first()).n, 1,
  'repeated identical cycle errors must be coalesced before D1 persistence');

  const nextNonce = crypto.randomUUID();
  const nextSignature = await crypto.subtle.sign('Ed25519', keys.privateKey,
    new TextEncoder().encode(['POST', route, timestamp, nextNonce, hash].join('\n')));
  const stable = await mf.dispatchFetch('https://local.test' + route, {...options,
    headers: {...options.headers, 'x-node-request-id': nextNonce,
      'x-node-signature': Buffer.from(nextSignature).toString('base64url')}});
  assert.equal(stable.status, 200, await stable.clone().text());
  assert.equal(Number(stable.headers.get('x-test-d1-writes')), 0,
    'identical sync including SSH must write zero actual D1 rows, including indexes');
  for (const [name, sql] of [
    ['heartbeat', "UPDATE nodes SET last_seen_at = datetime('now', '-241 seconds')"],
    ['ai', "UPDATE node_ai_state SET updated_at = datetime('now', '-301 seconds')"]
  ]) {
    await db.prepare(sql).run();
    if (name === 'ai') await db.prepare("UPDATE node_ai_runtime_state SET updated_at = datetime('now', '-301 seconds')").run();
    const requestId = crypto.randomUUID();
    const signature = await crypto.subtle.sign('Ed25519', keys.privateKey,
      new TextEncoder().encode(['POST', route, timestamp, requestId, hash].join('\n')));
    const refreshed = await mf.dispatchFetch('https://local.test' + route, {...options,
      headers: {...options.headers, 'x-node-request-id': requestId,
        'x-node-signature': Buffer.from(signature).toString('base64url')}});
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    assert.equal(Number(refreshed.headers.get('x-test-d1-writes')), 3,
      `${name} budget must include all modified table/index rows`);
    console.log(`${name} refresh actual local D1 rows_written: ${refreshed.headers.get('x-test-d1-writes')}`);
  }
  await db.prepare("UPDATE nodes SET status = 'revoked' WHERE node_id = ?").bind(nodeId).run();
  response = await mf.dispatchFetch('https://local.test' + route, options);
  assert.equal(response.status, 403);
  console.log('Actual workerd + local D1: signed sync, Durable Object replay rejection, zero D1 nonce writes and revocation: PASS');
} finally {
  await mf.dispose();
}
