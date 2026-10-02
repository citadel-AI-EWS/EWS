import http from 'node:http';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import ssh2 from 'ssh2';
import {WebSocketServer, WebSocket} from 'ws';
import {verifySshTicket} from '../src/ssh/tickets.js';
import {TicketReplayStore} from './replay-store.mjs';

const {Client} = ssh2;
const RESTRICTED_CONSOLE_BANNER = 'CITADEL Restricted SSH Console';
const fingerprint = key => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
function targetConfig(target) {
  if (!target || typeof target.host !== 'string' || !/^[A-Za-z0-9.:-]{1,253}$/.test(target.host) ||
      !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 ||
      typeof target.username !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(target.username) ||
      !/^SHA256:[A-Za-z0-9+/]{43}$/.test(target.hostKeySha256 || '') || !target.privateKey) {
    throw Error('invalid_gateway_target');
  }
  return target;
}

// Targets and credentials are administrator-provisioned. Neither a browser nor
// a session ticket can supply a network destination, username or private key.
export function loadTargets(filename) {
  const source = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const targets = new Map();
  for (const [id, value] of Object.entries(source)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id) || typeof value.privateKeyFile !== 'string') throw Error('invalid_gateway_target');
    targets.set(id, targetConfig({...value, privateKey: fs.readFileSync(value.privateKeyFile)}));
  }
  return targets;
}

export function createSshGateway({secret, targets, hubOrigin, idleMs = 600000, maxSessions = 32,
  replayStore = null,
  audit = event => process.stdout.write(JSON.stringify(event) + '\n')}) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512 || /\s/.test(secret)) throw Error('ssh_gateway_secret_invalid');
  const origin = new URL(hubOrigin);
  const loopbackOrigin = origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== hubOrigin || !(origin.protocol === 'https:' || loopbackOrigin)) throw Error('invalid_hub_origin');
  if (!(targets instanceof Map)) throw Error('invalid_gateway_targets');
  for (const [id, value] of targets) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) throw Error('invalid_gateway_target');
    targetConfig(value);
  }
  replayStore ||= new TicketReplayStore(':memory:');
  const sessions = new Map();
  let pending = 0;
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 404, {'content-type': 'application/json', 'cache-control': 'no-store'});
    response.end(JSON.stringify(request.url === '/health' ? {ok: true, service: 'citadel-ssh-gateway'} : {ok: false}));
  });
  const wss = new WebSocketServer({noServer: true, maxPayload: 8192, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has('citadel-ssh-v1') ? 'citadel-ssh-v1' : false});
  const reject = (socket, status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  server.on('upgrade', async (request, socket, head) => {
    if (request.url !== '/ssh' || request.headers.origin !== hubOrigin ||
        request.headers['sec-websocket-protocol'] !== 'citadel-ssh-v1') return reject(socket, '403 Forbidden');
    if (pending >= 64 || sessions.size >= maxSessions) return reject(socket, '503 Service Unavailable');
    pending++;
    try {
      const claims = await verifySshTicket(secret, request.headers['x-citadel-ssh-ticket']);
      if (sessions.size >= maxSessions ||
          [...sessions.values()].filter(s => s.actor_id === claims.actor_id).length >= 2) return reject(socket, '429 Too Many Requests');
      const result = replayStore.consume(claims.jti, claims.exp);
      if (result !== 'ok') return reject(socket, result === 'used' ? '403 Forbidden' : '429 Too Many Requests');
      wss.handleUpgrade(request, socket, head, ws => startSession(ws, claims));
    } catch { reject(socket, '403 Forbidden'); }
    finally { pending--; }
  });

  function startSession(ws, claims) {
    const target = targets.get(claims.node_id);
    const ssh = new Client();
    let channel = null, done = false, reason = 'disconnected', exitCode = null, handshakeTimer = null;
    let lastActivity = Date.now(), inputBytes = 0, inputWindow = Date.now();
    sessions.set(claims.jti, claims);
    const send = event => {if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));};
    const finish = code => {
      if (done) return;
      done = true; reason = code; clearInterval(timer); if (handshakeTimer) clearTimeout(handshakeTimer); sessions.delete(claims.jti);
      channel?.destroy(); ssh.destroy();
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, code);
      audit({event: 'ssh.closed', node_id: claims.node_id, actor_id: claims.actor_id, session_id: claims.jti, reason, exit_code: exitCode});
    };
    const fail = code => {send({type: 'error', code}); finish(code);};
    const timer = setInterval(() => {
      if (Date.now() >= claims.session_exp * 1000) return fail('session_expired');
      if (Date.now() - lastActivity >= idleMs) return fail('session_idle_timeout');
      if (ws.bufferedAmount > 2 * 1024 * 1024) return fail('terminal_client_too_slow');
      if (channel && ws.bufferedAmount < 256 * 1024) channel.resume();
    }, 1000);
    timer.unref();
    ws.on('close', () => finish(reason));
    ws.on('error', () => finish('socket_error'));
    ws.on('message', (data, binary) => {
      if (done || !channel) return;
      lastActivity = Date.now();
      if (binary) {
        if (Date.now() - inputWindow >= 1000) {inputWindow = Date.now(); inputBytes = 0;}
        inputBytes += data.length;
        if (inputBytes > 65536 || channel.writableLength > 65536) return fail('terminal_input_limit');
        channel.write(data);
      } else {
        let command;
        try {command = JSON.parse(data.toString());} catch {return fail('invalid_terminal_message');}
        if (command?.type !== 'resize' || !Number.isInteger(command.cols) || !Number.isInteger(command.rows) ||
            command.cols < 20 || command.cols > 300 || command.rows < 5 || command.rows > 150) return fail('invalid_terminal_size');
        channel.setWindow(command.rows, command.cols, 0, 0);
      }
    });
    ssh.on('error', () => fail('ssh_connection_failed'));
    ssh.on('close', () => finish(reason));
    if (!target) return fail('ssh_target_not_configured');
    ssh.on('ready', () => {
      if (done) return;
      ssh.shell({term: 'xterm-256color', cols: 80, rows: 24}, (error, stream) => {
        if (error) return fail('ssh_shell_unavailable');
        if (done) return stream.destroy();
        const preface = [];
        let prefaceBytes = 0, restrictedVerified = false;
        const forward = data => {
          if (done || ws.readyState !== WebSocket.OPEN) return;
          lastActivity = Date.now();
          if (ws.bufferedAmount > 2 * 1024 * 1024) return fail('terminal_client_too_slow');
          ws.send(data, {binary: true});
          if (channel && ws.bufferedAmount > 512 * 1024) channel.pause();
        };
        const verifyOutput = data => {
          if (restrictedVerified) return forward(data);
          preface.push(Buffer.from(data)); prefaceBytes += data.length;
          if (prefaceBytes > 16 * 1024) return fail('ssh_restricted_console_required');
          const text = Buffer.concat(preface).toString('utf8');
          if (!text.includes(RESTRICTED_CONSOLE_BANNER)) return;
          restrictedVerified = true; if (handshakeTimer) clearTimeout(handshakeTimer); handshakeTimer = null;
          channel = stream;
          forward(Buffer.concat(preface));
          audit({event: 'ssh.opened', node_id: claims.node_id, actor_id: claims.actor_id, session_id: claims.jti, restricted_console: true});
          send({type: 'ready', node_id: claims.node_id, session_id: claims.jti, expires_at: new Date(claims.session_exp * 1000).toISOString()});
        };
        handshakeTimer = setTimeout(() => fail('ssh_restricted_console_required'), 5000);
        handshakeTimer.unref?.();
        stream.on('data', verifyOutput); stream.stderr.on('data', verifyOutput);
        stream.on('exit', (code, signal) => {exitCode = Number.isInteger(code) ? code : null; reason = 'ssh_exited'; send({type: 'exit', code: exitCode, signal: signal || null});});
        stream.on('close', () => finish(reason));
        stream.on('error', () => fail('ssh_channel_failed'));
      });
    });
    try {
      ssh.connect({host: target.host, port: target.port, username: target.username, privateKey: target.privateKey,
        hostVerifier: key => fingerprint(key) === target.hostKeySha256,
        readyTimeout: 10000, keepaliveInterval: 15000, keepaliveCountMax: 3});
    } catch {fail('ssh_connection_failed');}
  }
  return {server, async close() {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
    wss.close(); replayStore.close();
  }};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const gateway = createSshGateway({secret: process.env.SSH_GATEWAY_TICKET_SECRET,
      replayStore: new TicketReplayStore(process.env.CITADEL_SSH_REPLAY_DB || '/var/lib/citadel-ssh/replays.sqlite'),
      hubOrigin: process.env.CITADEL_HUB_ORIGIN, targets: loadTargets(process.env.CITADEL_SSH_TARGETS_FILE)});
    const port = Number(process.env.PORT || 8080);
    gateway.server.listen(port, '127.0.0.1', () => process.stdout.write('CITADEL SSH gateway listening on loopback\n'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => gateway.close().then(() => process.exit(0)));
  } catch {process.stderr.write('CITADEL SSH gateway configuration invalid\n'); process.exit(1);}
}
