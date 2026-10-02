import fs from 'node:fs';
import net from 'node:net';
import {createHash} from 'node:crypto';
import ssh2 from 'ssh2';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {createSshGateway} from '../../gateway/server.mjs';

export async function sshFixture({assets = false} = {}) {
  const {Server, utils} = ssh2;
  const hostKeys = utils.generateKeyPairSync('ed25519'), userKeys = utils.generateKeyPairSync('ed25519');
  const publicKey = utils.parseKey(userKeys.private);
  const hash = key => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  const clients = new Set(), commands = [], windows = [], audit = [], upgrades = [];
  const ssh = new Server({hostKeys: [hostKeys.private]}, client => {
    let authenticatedUser = '';
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      if (['operator', 'unrestricted'].includes(ctx.username) && ctx.method === 'publickey' &&
          ctx.key.data.equals(publicKey.getPublicSSH()) && (!ctx.signature || publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) {authenticatedUser = ctx.username; ctx.accept();}
      else ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', (accept, reject, info) => {windows.push(info); accept();});
      session.on('window-change', (accept, reject, info) => {windows.push(info); accept?.();});
      session.on('shell', accept => {
        const stream = accept();
        stream.on('error', () => {});
        stream.write(authenticatedUser === 'operator' ? '\u001b[32mCITADEL Restricted SSH Console\u001b[0m\r\nCITADEL_REAL_SSH_READY\r\ncitadel> ' : 'UNRESTRICTED_SHELL_READY\r\n$ ');
        let input = '';
        stream.on('data', data => {
          input += data.toString('utf8'); stream.write(data);
          const lines = input.split(/\r\n|[\r\n]/); input = lines.pop();
          for (const line of lines) {
            commands.push(line);
            if (line === 'exit') {stream.exit(0); stream.end();}
            else stream.write('\r\nSSH_RESULT:' + line + '\r\noperator> ');
          }
        });
      });
    }));
  });
  await new Promise(resolve => ssh.listen(0, '127.0.0.1', resolve));
  const tempServer = net.createServer();
  await new Promise(resolve => tempServer.listen(0, '127.0.0.1', resolve));
  const hubPort = tempServer.address().port;
  await new Promise(resolve => tempServer.close(resolve));
  const origin = 'http://127.0.0.1:' + hubPort;
  const secret = 'fixture-ticket-secret-not-a-production-key';
  const target = {host: '127.0.0.1', port: ssh.address().port, username: 'operator',
    privateKey: userKeys.private, hostKeySha256: hash(utils.parseKey(hostKeys.private).getPublicSSH())};
  const gateway = createSshGateway({secret, hubOrigin: origin, targets: new Map([
    ['node-one', target], ['node-two', target], ['bad-pin', {...target, hostKeySha256: 'SHA256:' + 'A'.repeat(43)}],
    ['unrestricted', {...target, username: 'unrestricted'}]
  ]), audit: event => audit.push(event)});
  gateway.server.prependListener('upgrade', req => upgrades.push({url: req.url, authorization: req.headers.authorization, origin: req.headers.origin}));
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  const token = 'fixture-owner-token', operator = 'fixture-operator-token', viewer = 'fixture-viewer-token';
  const tokenHash = token => createHash('sha256').update(token).digest('hex');
  const bundle = await build({entryPoints: ['src/worker.js'], bundle: true, format: 'esm', write: false});
  const mf = new Miniflare(convertV4MiniflareOptions({modules: true, script: bundle.outputFiles[0].text,
    host: '127.0.0.1', port: hubPort, compatibilityDate: '2026-09-05', d1Databases: ['DB'],
    ...(assets ? {assets: {directory: 'public', binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: {has_user_worker: true}}} : {}),
    bindings: {ARCHITECT_TOKEN_HASH: tokenHash(token), SSH_GATEWAY_TICKET_SECRET: secret,
      SSH_GATEWAY_URL: 'http://127.0.0.1:' + gateway.server.address().port + '/ssh'}}));
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const file of fs.readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of fs.readFileSync('migrations/' + file, 'utf8').replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  for (const id of ['node-one', 'node-two', 'bad-pin', 'unmapped', 'unrestricted']) {
    await db.prepare("INSERT INTO nodes (node_id, public_key, hostname, os_name, agent_version, status) VALUES (?, ?, ?, 'Linux', '0.3.32', 'online')").bind(id, 'fixture-key-' + id, 'Хост ' + id).run();
  }
  for (const [id, credential, role] of [['operator', operator, 'operator'], ['viewer', viewer, 'viewer']]) {
    await db.prepare('INSERT INTO architect_access_tokens (token_id, token_hash, role, label) VALUES (?, ?, ?, ?)').bind(id, tokenHash(credential), role, id).run();
  }
  async function request(path, {credential = token, method = 'GET', body, headers = {}} = {}) {
    return fetch(origin + '/api/v1/architect' + path, {method, headers: {authorization: 'Bearer ' + credential,
      'content-type': 'application/json', ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  }
  async function ticket(node = 'node-one') {
    const response = await request('/nodes/' + node + '/ssh/session', {method: 'POST', body: {}});
    if (!response.ok) throw Error('fixture ticket rejected: ' + response.status + ' ' + await response.text());
    return (await response.json()).ticket;
  }
  return {origin, secret, token, operator, viewer, commands, windows, audit, upgrades, db, mf, request, ticket,
    async close() {
      await mf.dispose(); await gateway.close();
      for (const client of clients) client.end();
      await new Promise(resolve => ssh.close(resolve));
    }};
}
