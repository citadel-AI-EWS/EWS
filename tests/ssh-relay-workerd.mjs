import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {build} from 'esbuild';
import {WebSocket} from 'ws';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

const reserve = net.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const browserTest = process.argv.includes('--browser');
const owner = 'fixture-ssh-relay-owner';
const nodeId = 'node_relay_test';
const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const jwk = publicKey.export({format: 'jwk'});
const bundle = await build({entryPoints: ['src/worker.js'], bundle: true, format: 'esm', write: false});
const mf = new Miniflare(convertV4MiniflareOptions({modules: true, script: bundle.outputFiles[0].text,
  host: '127.0.0.1', port, compatibilityDate: '2026-09-05', d1Databases: ['DB'],
  ...(browserTest ? {assets: {directory: 'public', binding: 'ASSETS',
    run_worker_first: ['/api/*'], routerConfig: {has_user_worker: true}}} : {}),
  durableObjects: {SSH_RELAY: {className: 'NodeSshRelay', useSQLite: true}},
  bindings: {ARCHITECT_TOKEN_HASH: createHash('sha256').update(owner).digest('hex')}}));
const sockets = [];
function connect(path, protocols, headers = {}) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + path, protocols, {headers});
  socket.on('error', () => {});
  sockets.push(socket);
  return socket;
}
function opened(socket) {return new Promise((resolve, reject) => {
  socket.once('open', resolve); socket.once('error', reject);
  socket.once('unexpected-response', (_req, response) => reject(Error(`HTTP ${response.statusCode}`)));
});}
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('relay event timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
try {
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const file of fs.readdirSync('migrations').filter(file => file.endsWith('.sql')).sort()) {
    for (const sql of fs.readFileSync('migrations/' + file, 'utf8').replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean)) {
      await db.prepare(sql).run();
    }
  }
  await db.prepare("INSERT INTO nodes (node_id, public_key, hostname, os_name, agent_version, status) VALUES (?, ?, ?, 'Linux', '0.3.38', 'online')")
    .bind(nodeId, JSON.stringify({kty: jwk.kty, crv: jwk.crv, x: jwk.x}), 'relay-test').run();
  const sessionPath = `/api/v1/architect/nodes/${nodeId}/ssh/session`;
  const auth = {authorization: `Bearer ${owner}`, 'content-type': 'application/json'};
  const initial = await fetch(origin + sessionPath, {headers: auth});
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).can_connect, false);
  const route = `/api/v1/nodes/${nodeId}/ssh/relay`;
  const stamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const hash = createHash('sha256').update('').digest('hex');
  const signature = sign(null, Buffer.from(['GET', route, stamp, nonce, hash].join('\n')), privateKey).toString('base64url');
  const agent = connect(route, ['citadel-ssh-agent-v1'], {'x-node-id': nodeId,
    'x-node-timestamp': stamp, 'x-node-request-id': nonce, 'x-node-signature': signature});
  await opened(agent);
  const status = await fetch(origin + sessionPath, {headers: auth});
  assert.equal((await status.json()).can_connect, true);
  const issued = await fetch(origin + sessionPath, {method: 'POST', headers: auth, body: '{}'});
  assert.equal(issued.status, 200, await issued.clone().text());
  const {ticket, websocket_path} = await issued.json();
  assert.equal(websocket_path, '/api/v1/architect/ssh/relay/connect');
  const agentFrames = [], browserFrames = [];
  agent.on('message', (data, binary) => agentFrames.push(binary ? Buffer.from(data) : JSON.parse(data.toString())));
  const browser = connect(websocket_path, ['citadel-ssh-v1', 'ticket.' + ticket], {origin});
  browser.on('message', (data, binary) => browserFrames.push(binary ? Buffer.from(data) : JSON.parse(data.toString())));
  await opened(browser);
  await until(() => agentFrames.some(frame => frame.type === 'start'));
  agent.send(JSON.stringify({type: 'ready', node_id: nodeId}));
  await until(() => browserFrames.some(frame => frame.type === 'ready'));
  browser.send(Buffer.from('hostname\r'));
  await until(() => agentFrames.some(frame => Buffer.isBuffer(frame) && frame.toString() === 'hostname\r'));
  agent.send(Buffer.from('relay-test\r\n'));
  await until(() => browserFrames.some(frame => Buffer.isBuffer(frame) && frame.toString() === 'relay-test\r\n'));
  const replay = connect(websocket_path, ['citadel-ssh-v1', 'ticket.' + ticket], {origin});
  const replayCode = await new Promise(resolve => replay.once('unexpected-response', (_req, response) => resolve(response.statusCode)));
  assert.equal(replayCode, 503);
  browser.close();
  await until(() => agentFrames.some(frame => frame.type === 'stop'));
  console.log('Workerd relay: signed agent, owner ticket, binary stream, replay and stop PASS');
  if (browserTest) {
    const {chromium} = await import('@playwright/test');
    const browser = await chromium.launch({headless: true});
    try {
      let agentInput = '';
      agent.on('message', (data, binary) => {
        if (!binary && JSON.parse(data.toString()).type === 'start') {
          agent.send(JSON.stringify({type: 'ready', node_id: nodeId}));
          agent.send(Buffer.from('CITADEL Restricted SSH Console\r\ncitadel> '));
        }
        if (binary) {
          agentInput += data.toString();
          if (agentInput.includes('\r') || agentInput.includes('\n')) {
            if (agentInput.includes('hostname')) agent.send(Buffer.from('relay-browser-host\r\ncitadel> '));
            agentInput = '';
          }
        }
      });
      const page = await browser.newPage({viewport: {width: 1280, height: 850}});
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.locator('#token').fill(owner);
      await page.locator('#login button').click();
      await page.locator('#nodes h2').filter({hasText: 'relay-test'}).waitFor();
      await page.locator('#nodes .node-card').filter({has: page.locator('h2', {hasText: 'relay-test'})})
        .getByRole('button', {name: 'SSH', exact: true}).click();
      await page.locator('#sshStatus').filter({hasText: 'Агент узла подключён.'}).waitFor();
      await page.getByRole('button', {name: 'Подключиться', exact: true}).click();
      await page.locator('#sshStatus').filter({hasText: 'SSH подключён.'}).waitFor();
      await page.locator('#sshTerminal .xterm-helper-textarea').pressSequentially('hostname');
      await page.locator('#sshTerminal .xterm-helper-textarea').press('Enter');
      await page.waitForFunction(() => document.getElementById('sshTerminal').innerText.includes('relay-browser-host'));
      assert.deepEqual(errors, []);
      console.log('SSH browser auto-relay: select node, connect and terminal I/O PASS');
    } finally {await browser.close();}
  }
} finally {
  for (const socket of sockets) socket.terminate();
  await mf.dispose();
}
