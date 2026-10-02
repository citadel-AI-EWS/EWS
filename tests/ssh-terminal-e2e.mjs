import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WebSocket} from 'ws';
import {issueSshTicket, verifySshTicket} from '../src/ssh/tickets.js';
import {sshFixture} from './helpers/ssh-fixture.mjs';
import {TicketReplayStore} from '../gateway/replay-store.mjs';

const gatewaySource = fs.readFileSync('gateway/server.mjs', 'utf8');
const caddySource = fs.readFileSync('gateway/Caddyfile.example', 'utf8');
const deployWorkflow = fs.readFileSync('.github/workflows/deploy-cloudflare.yml', 'utf8');
const hubSource = fs.readFileSync('operations.html', 'utf8');
assert.ok(gatewaySource.includes("const loopbackOrigin = origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);"), 'plaintext Hub origin must be loopback-only');
assert.match(caddySource, /route\s*\{[\s\S]*reverse_proxy @ssh 127\.0\.0\.1:8080[\s\S]*respond 404[\s\S]*\}/, 'Caddy /ssh proxy must run before fallback');
assert.ok(deployWorkflow.includes('{"SSH_GATEWAY_URL":null,"SSH_GATEWAY_TICKET_SECRET":null}'), 'disabling direct SSH must delete persisted Worker gateway secrets');
assert.ok(hubSource.includes("window.addEventListener('pagehide',()=>{if($('directSshDialog').open)$('directSshDialog').close();sshTerminal.close();"), 'bfcache pagehide must reset direct SSH terminal');

const f = await sshFixture({assets: process.argv.includes('--browser')});
const sockets = new Set();
function connect(ticket, origin = f.origin) {
  const socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/api/v1/architect/ssh/connect',
    ['citadel-ssh-v1', 'ticket.' + ticket], {headers: {origin}});
  sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
  const events = [], output = [];
  socket.on('error', error => events.push({type: 'socket_error', message: error.message}));
  socket.on('message', (data, binary) => binary ? output.push(data.toString()) : events.push(JSON.parse(data)));
  const waitFor = async predicate => {
    const until = Date.now() + 15000;
    while (!predicate()) {if (events.some(e => e.type === 'socket_error') || Date.now() > until) throw Error('SSH event timeout: ' + JSON.stringify(events)); await new Promise(resolve => setTimeout(resolve, 20));}
  };
  return {socket, events, output, waitFor};
}
async function refused(ticket, origin = f.origin) {
  return new Promise((resolve, reject) => {
    const {socket} = connect(ticket, origin);
    socket.once('unexpected-response', (request, response) => {response.resume(); socket.terminate(); resolve(response.statusCode);});
    socket.once('open', () => {socket.close(); reject(Error('unauthorized socket opened'));});
  });
}
try {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-replay-'));
  try {
    const filename = path.join(directory, 'replay.sqlite');
    let store = new TicketReplayStore(filename);
    assert.equal(store.consume('test-ticket', 200, 100), 'ok'); store.close();
    store = new TicketReplayStore(filename);
    assert.equal(store.consume('test-ticket', 200, 100), 'used', 'consumed ticket survives process restart');
    assert.equal(store.consume('test-ticket', 300, 200), 'ok', 'expired entries are reclaimed'); store.close();
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
  const now = Math.floor(Date.now() / 1000);
  const {ticket: testTicket} = await issueSshTicket(f.secret, {node_id: 'node-one', actor_id: 'primary'}, now);
  assert.equal((await verifySshTicket(f.secret, testTicket, now)).node_id, 'node-one');
  await assert.rejects(verifySshTicket(f.secret, testTicket, now + 60), /invalid_ssh_ticket/);
  await assert.rejects(verifySshTicket(f.secret, testTicket.slice(0, -2) + 'AA'), /invalid_ssh_ticket/);
  const ticket = await f.ticket();
  let response = await f.request('/nodes/node-one/ssh/session', {credential: 'invalid', method: 'POST', body: {}});
  assert.equal(response.status, 401);
  for (const credential of [f.operator, f.viewer]) {
    response = await f.request('/nodes/node-one/ssh/session', {credential, method: 'POST', body: {}});
    assert.equal(response.status, 403, 'full SSH requires owner permission');
  }
  response = await f.request('/nodes/node-one/ssh/session', {method: 'POST', body: {host: 'attacker.example'}});
  assert.equal(response.status, 400, 'browser cannot override approved target');
  assert.equal((await f.request('/nodes/missing/ssh/session', {method: 'POST', body: {}})).status, 404);
  assert.equal(await refused(ticket, 'https://untrusted.example'), 403);
  const {ticket: expiredTicket} = await issueSshTicket(f.secret, {node_id: 'node-one', actor_id: 'primary'}, now - 61);
  assert.equal(await refused(expiredTicket), 401);
  assert.equal(await refused(ticket.slice(0, -2) + 'AA'), 401);
  const viewerStatus = await f.request('/nodes/node-one/ssh/session', {credential: f.viewer});
  assert.equal((await viewerStatus.json()).can_connect, false);
  const stream = connect(ticket);
  await stream.waitFor(() => stream.events.some(e => e.type === 'ready'));
  await stream.waitFor(() => stream.output.join('').includes('CITADEL_REAL_SSH_READY'));
  assert.equal(stream.events[0].node_id, 'node-one');
  stream.socket.send(JSON.stringify({type: 'resize', cols: 110, rows: 35}));
  stream.socket.send(Buffer.from('status\r'));
  await stream.waitFor(() => stream.output.join('').includes('SSH_RESULT:status'));
  assert.ok(f.windows.some(w => w.cols === 110 && w.rows === 35), 'PTY resize reached SSH host');
  assert.equal(await refused(ticket), 503, 'gateway rejects consumed tickets');
  stream.socket.send(Buffer.from('exit\r'));
  await stream.waitFor(() => stream.events.some(e => e.type === 'exit' && e.code === 0));
  await stream.waitFor(() => stream.socket.readyState === WebSocket.CLOSED);
  for (const [node, expected] of [['bad-pin', 'ssh_connection_failed'], ['unmapped', 'ssh_target_not_configured'], ['unrestricted', 'ssh_restricted_console_required']]) {
    const denied = connect(await f.ticket(node));
    await denied.waitFor(() => denied.events.some(e => e.type === 'error' && e.code === expected));
    assert.ok(!denied.events.some(e => e.type === 'ready'));
  }
  const revoked = await f.ticket('node-two');
  await f.db.prepare("UPDATE nodes SET status = 'revoked' WHERE node_id = 'node-two'").run();
  assert.equal(await refused(revoked), 404, 'revocation after ticket issuance blocks connection');
  await f.db.prepare("UPDATE nodes SET status = 'online' WHERE node_id = 'node-two'").run();
  assert.ok(f.upgrades.every(r => r.url === '/ssh' && !r.authorization), 'Architect credential and ticket query are never forwarded');
  assert.ok(f.audit.some(e => e.event === 'ssh.opened') && f.audit.some(e => e.event === 'ssh.closed'));
  assert.doesNotMatch(JSON.stringify(f.audit), /PRIVATE KEY|fixture-owner-token/);
  const events = (await f.db.prepare("SELECT details_json FROM audit_events WHERE action='ssh.session.issued'").all()).results;
  assert.ok(events.length >= 4); assert.ok(events.every(e => !e.details_json.includes('ticket')));
  console.log('SSH E2E: actual Worker/WebSocket/SSH, key pinning, PTY, auth, replay, revocation and audit PASS');

  if (process.argv.includes('--browser')) {
    const {chromium} = await import('@playwright/test');
    const browser = await chromium.launch({headless: true});
    try {
      const page = await browser.newPage({viewport: {width: 1365, height: 900}});
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(f.origin);
      await page.locator('#token').fill(f.token); await page.locator('#login button').click();
      await page.locator('#nodes h2').filter({hasText: 'Хост node-one'}).waitFor();
      await page.locator('#nodes .node-card').filter({has: page.locator('h2', {hasText: 'Хост node-one'})}).getByRole('button', {name: 'SSH', exact: true}).click();
      await page.getByRole('button', {name: 'Подключиться', exact: true}).click();
      await page.locator('#sshStatus').filter({hasText: 'SSH подключён.'}).waitFor();
      await page.locator('#sshTerminal .xterm-helper-textarea').pressSequentially('status');
      await page.locator('#sshTerminal .xterm-helper-textarea').press('Enter');
      await page.waitForFunction(() => document.getElementById('sshTerminal').innerText.includes('SSH_RESULT:status'));
      await page.locator('#sshNodeSelect').selectOption('node-two');
      await page.locator('#sshStatus').filter({hasText: 'Готов к подключению.'}).waitFor();
      assert.ok(!(await page.locator('#sshTerminal').innerText()).includes('SSH_RESULT:status'), 'switch clears previous node output');
      await page.locator('#sshConnect').click();
      await page.locator('#sshStatus').filter({hasText: 'SSH подключён.'}).waitFor();
      await page.locator('#sshTerminal .xterm-helper-textarea').pressSequentially('hostname');
      await page.locator('#sshTerminal .xterm-helper-textarea').press('Enter');
      await page.waitForFunction(() => document.getElementById('sshTerminal').innerText.includes('SSH_RESULT:hostname'));
      await page.locator('#sshDisconnect').click();
      await page.locator('#sshStatus').filter({hasText: 'Сеанс отключён.'}).waitFor();
      assert.equal(await page.locator('#sshConnect').isEnabled(), true, 'manual disconnect permits reconnect');
      await page.locator('#sshConnect').click();
      await page.locator('#sshStatus').filter({hasText: 'SSH подключён.'}).waitFor();
      await page.locator('#closeDirectSsh').click();
      await page.waitForTimeout(100);
      assert.ok(f.audit.filter(e => e.event === 'ssh.closed').length >= 4, 'closing dialog terminates SSH');
      await page.setViewportSize({width: 390, height: 844});
      await page.locator('#nodes .node-card').filter({has: page.locator('h2', {hasText: 'Хост node-one'})}).getByRole('button', {name: 'SSH', exact: true}).click();
      await page.locator('#sshStatus').filter({hasText: 'Готов к подключению.'}).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.locator('#sshConnect').click();
      await page.locator('#sshStatus').filter({hasText: 'SSH подключён.'}).waitFor();
      await page.screenshot({path: '/tmp/citadel-ssh-terminal-mobile.png', fullPage: true});
      await page.evaluate(() => document.getElementById('logout').click());
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#directSshDialog').evaluate(el => el.open), false);
      assert.deepEqual(errors, []);
      console.log('SSH browser: real terminal I/O, node switch, disconnect, mobile and logout PASS');
    } finally {await browser.close();}
  }
} finally {
  for (const socket of sockets) socket.terminate();
  await f.close();
}
