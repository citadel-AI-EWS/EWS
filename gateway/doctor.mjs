import {pathToFileURL} from 'node:url';
import {WebSocket} from 'ws';
import {issueSshTicket} from '../src/ssh/tickets.js';
import {createSshGateway, loadTargets} from './server.mjs';

const NODE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

async function probe(url, hubOrigin, secret, nodeId, timeoutMs) {
  const {ticket} = await issueSshTicket(secret, {node_id: nodeId, actor_id: 'gateway-doctor'});
  return new Promise(resolve => {
    const socket = new WebSocket(url, 'citadel-ssh-v1', {
      headers: {origin: hubOrigin, 'x-citadel-ssh-ticket': ticket},
      handshakeTimeout: timeoutMs
    });
    let finished = false;
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.terminate();
      resolve({node_id: nodeId, status: code === 'ready' ? 'ready' : 'failed', code});
    };
    const timer = setTimeout(() => finish('ssh_probe_timeout'), timeoutMs);
    timer.unref?.();
    socket.on('message', (data, binary) => {
      if (binary) return;
      let event;
      try {event = JSON.parse(data.toString());} catch {return finish('ssh_probe_invalid_response');}
      if (event.type === 'ready' && event.node_id === nodeId) finish('ready');
      else if (event.type === 'error') finish(typeof event.code === 'string' ? event.code : 'ssh_probe_failed');
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      finish('gateway_http_' + response.statusCode);
    });
    socket.on('error', () => finish('ssh_probe_connection_failed'));
    socket.on('close', () => finish('ssh_probe_closed'));
  });
}

// Uses the same ticket, WebSocket, pinned-key and restricted-console path as Hub.
// It does not need D1 or an Architect token, so it can diagnose a host while D1 is exhausted.
export async function runGatewayDoctor({secret, hubOrigin, targets, nodeIds = [...targets.keys()], timeoutMs = 15000}) {
  if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.some(id => !NODE_ID.test(id))) throw Error('ssh_doctor_no_valid_targets');
  const gateway = createSshGateway({secret, hubOrigin, targets, audit: () => {}});
  try {
    await new Promise((resolve, reject) => {
      gateway.server.once('error', reject);
      gateway.server.listen(0, '127.0.0.1', resolve);
    });
    const url = `ws://127.0.0.1:${gateway.server.address().port}/ssh`;
    const nodes = [];
    for (const id of nodeIds) nodes.push(await probe(url, hubOrigin, secret, id, timeoutMs));
    return {ok: nodes.every(node => node.status === 'ready'), nodes};
  } finally {
    await gateway.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--node' || !NODE_ID.test(args[1]))) throw Error('ssh_doctor_invalid_arguments');
    const targets = loadTargets(process.env.CITADEL_SSH_TARGETS_FILE);
    const result = await runGatewayDoctor({secret: process.env.SSH_GATEWAY_TICKET_SECRET,
      hubOrigin: process.env.CITADEL_HUB_ORIGIN, targets,
      nodeIds: args.length ? [args[1]] : [...targets.keys()]});
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stderr.write('SSH doctor configuration invalid or probe failed.\n');
    process.exitCode = 1;
  }
}
