import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

// The real Worker runtime and local D1 binding; no remote resource is configured.
const bundle = await build({entryPoints: ['src/worker.js'], bundle: true, format: 'esm', write: false});
const mf = new Miniflare(convertV4MiniflareOptions({modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-09-05', d1Databases: ['DB']}));
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
  const body = JSON.stringify({heartbeat: {agent_version: '0.3.24', cpu_percent: 2, memory_percent: 20},
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
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM node_request_nonces').first()).n, 1);
  response = await mf.dispatchFetch('https://local.test' + route, options);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'replayed_request');
  await db.prepare("UPDATE nodes SET status = 'revoked' WHERE node_id = ?").bind(nodeId).run();
  response = await mf.dispatchFetch('https://local.test' + route, options);
  assert.equal(response.status, 403);
  console.log('Actual workerd + local D1: signed sync, one nonce, replay rejection and revocation: PASS');
} finally {
  await mf.dispose();
}
