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
    let replayExpires = null;
    const mode = request.headers.get('x-test-relay-mode');
    const relay = env.SSH_RELAY;
    const SSH_RELAY = mode === 'absent' ? undefined : {
      idFromName: name => relay.idFromName(name),
      get: id => ({async fetch(input, options) {
        if (mode === 'unavailable') throw Error('test relay outage');
        const req = new Request(input, options);
        if (req.headers.get('x-citadel-relay-role') === 'replay') {
          replayExpires = Number(req.headers.get('x-citadel-request-expires'));
        }
        const result = await relay.get(id).fetch(input, options);
        if (mode === 'response-lost') throw Error('test response lost after committed claim');
        return result;
      }})
    };
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
    const response = await worker.fetch(request, {...env, DB, SSH_RELAY}, ctx);
    const output = new Response(response.body, response);
    output.headers.set('x-test-d1-writes', String(writes));
    if (replayExpires !== null) output.headers.set('x-test-replay-expires', String(replayExpires));
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
  // Replay stores must not form independent acceptance domains during outages
  // or migration. These use real signatures and the real Durable Object/D1.
  async function signedOptions(suffix, stamp = String(Math.floor(Date.now() / 1000))) {
    const path = `/api/v1/nodes/${nodeId}/${suffix}`;
    const method = suffix === 'logs' ? 'POST' : 'GET';
    const body = method === 'GET' ? '' : JSON.stringify({events: [{
      event_id: crypto.randomUUID(), level: 'info', event_type: 'command_completed',
      message: 'replay failover regression', created_at: new Date().toISOString()
    }]});
    const requestId = crypto.randomUUID();
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))).toString('hex');
    const signature = await crypto.subtle.sign('Ed25519', keys.privateKey,
      new TextEncoder().encode([method, path, stamp, requestId, digest].join('\n')));
    return {path, options: {method, ...(body ? {body} : {}), headers: {
      'content-type': 'application/json', 'x-node-id': nodeId, 'x-node-timestamp': stamp,
      'x-node-request-id': requestId, 'x-node-signature': Buffer.from(signature).toString('base64url')
    }}};
  }
  function send(fixture, mode) {
    return mf.dispatchFetch('https://local.test' + fixture.path, {...fixture.options,
      headers: {...fixture.options.headers, ...(mode ? {'x-test-relay-mode': mode} : {})}});
  }
  for (const suffix of ['assignments', 'logs']) {
    const original = await signedOptions(suffix);
    assert.ok((await send(original)).ok);
    response = await send(original, 'unavailable');
    assert.equal(response.status, 503, `${suffix}: DO outage must not accept a previously used nonce via D1`);
    assert.equal((await response.json()).error, 'node_replay_store_unavailable');
    assert.equal((await send(original)).status, 409);

    const ambiguous = await signedOptions(suffix);
    assert.equal((await send(ambiguous, 'response-lost')).status, 503);
    assert.equal((await send(ambiguous)).status, 409, 'a committed claim survives a lost response');

    const legacy = await signedOptions(suffix);
    assert.ok((await send(legacy, 'absent')).ok, 'D1-only deployments remain supported');
    assert.equal((await send(legacy, 'absent')).status, 409);
    assert.equal((await send(legacy)).status, 409, 'D1 nonce is honored when DO becomes available');

    const futureTimestamp = Math.floor(Date.now() / 1000) + 299;
    const future = await signedOptions(suffix, String(futureTimestamp));
    response = await send(future);
    assert.ok(response.ok, await response.clone().text());
    assert.ok(Number(response.headers.get('x-test-replay-expires')) > futureTimestamp + 300,
      'nonce must outlive the entire accepted signature window, including clock skew');
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM node_request_nonces').first()).n, 2,
    'only the two explicitly D1-only requests may create nonce rows');

  // Existing 0.3.1 agents use a nonce-less heartbeat route. Keep their wire
  // contract and measure the actual table/index writes in the Worker runtime.
  await db.prepare("UPDATE nodes SET agent_version = '0.3.1', last_seen_at = datetime('now', '-241 seconds')").run();
  const legacyRoute = `/api/v1/nodes/${nodeId}/heartbeat`;
  const legacyBody = JSON.stringify({agent_version: '0.3.1', cpu_percent: 2, memory_percent: 20});
  const legacyStamp = String(Math.floor(Date.now() / 1000));
  const legacyHash = Buffer.from(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(legacyBody))).toString('hex');
  const legacySignature = await crypto.subtle.sign('Ed25519', keys.privateKey,
    new TextEncoder().encode(['POST', legacyRoute, legacyStamp, legacyHash].join('\n')));
  const legacyOptions = {method: 'POST', body: legacyBody, headers: {
    'x-node-id': nodeId, 'x-node-timestamp': legacyStamp,
    'x-node-signature': Buffer.from(legacySignature).toString('base64url')
  }};
  response = await mf.dispatchFetch('https://local.test' + legacyRoute, legacyOptions);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(Number(response.headers.get('x-test-d1-writes')), 3,
    'legacy heartbeat must refresh its expired lease, including both indexes');
  const legacyState = await response.json();
  assert.equal(legacyState.status, 'online');
  assert.equal(legacyState.node_id, nodeId);
  response = await mf.dispatchFetch('https://local.test' + legacyRoute, legacyOptions);
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get('x-test-d1-writes')), 0,
    'unchanged legacy heartbeat must write zero actual D1 rows');
  await db.prepare("UPDATE nodes SET last_seen_at = datetime('now', '-241 seconds')").run();
  response = await mf.dispatchFetch('https://local.test' + legacyRoute, legacyOptions);
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get('x-test-d1-writes')), 3);
  await db.prepare("UPDATE nodes SET status = 'paused', last_seen_at = datetime('now', '-241 seconds')").run();
  response = await mf.dispatchFetch('https://local.test' + legacyRoute, legacyOptions);
  assert.equal((await response.json()).status, 'paused');
  assert.equal(Number(response.headers.get('x-test-d1-writes')), 3);
  console.log('Legacy 0.3.1 heartbeat actual D1 rows_written: initial=3, duplicate=0, refresh=3; paused preserved: PASS');
  await db.prepare("UPDATE nodes SET status = 'revoked' WHERE node_id = ?").bind(nodeId).run();
  response = await mf.dispatchFetch('https://local.test' + route, options);
  assert.equal(response.status, 403);
  console.log('Actual workerd + local D1: signed sync, Durable Object replay rejection, zero D1 nonce writes and revocation: PASS');
} finally {
  await mf.dispose();
}
