import {enqueueControllerReport, nodeReportsEnabled} from '../node-reports.js';

const MAX_FRAME = 8192;
const MAX_BUFFERED = 2 * 1024 * 1024;
// Batch expired replay/telemetry ticket cleanup; expiry still checked at claim time.
const BOOKKEEPING_SWEEP_SECONDS = 10 * 60;

function attachment(socket) {
  try {return socket.deserializeAttachment() || {};} catch {return {};}
}

// One Durable Object per registered node. Only the authenticated Worker can
// invoke fetch(); the browser and agent never receive a Durable Object URL.
export class NodeSshRelay {
  constructor(state, env = {}) {this.state = state; this.env = env;}

  async report(info, eventType, details) {
    if (!info.node_id || !await nodeReportsEnabled(this.env)) return;
    const id = crypto.randomUUID();
    const entry = {node_id: info.node_id, eventType, details, createdAt: new Date().toISOString(), id};
    try {
      await this.state.storage.put('report:' + id, entry);
      await this.deliverReport('report:' + id, entry);
    }
    catch {console.error('ssh_report_queue_unavailable');}
    try {await this.scheduleBookkeepingSweep();} catch {console.error('ssh_report_retry_schedule_unavailable');}
  }

  async deliverReport(key, entry) {
    const result = await enqueueControllerReport(this.env, entry.node_id, entry.eventType,
      entry.details, entry.createdAt, null, entry.id);
    if (result.status === 'queued') {await this.state.storage.delete(key); return true;}
    return false;
  }

  sockets(role) {
    return this.state.getWebSockets().filter(socket => attachment(socket).role === role);
  }

  async scheduleBookkeepingSweep() {
    const target = Date.now() + BOOKKEEPING_SWEEP_SECONDS * 1000;
    const current = await this.state.storage.getAlarm();
    if (current === null || current > target) await this.state.storage.setAlarm(target);
  }

  async fetch(request) {
    const role = request.headers.get('x-citadel-relay-role');
    if (role === 'status') {
      return Response.json({agent_connected: this.sockets('agent').length > 0},
        {headers: {'cache-control': 'no-store'}});
    }
    if (role === 'replay') {
      if (request.method !== 'POST') return new Response(null, {status: 405});
      const requestId = request.headers.get('x-citadel-request-id');
      const expires = Number(request.headers.get('x-citadel-request-expires'));
      const now = Math.floor(Date.now() / 1000);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId || '') ||
          !Number.isInteger(expires) || expires <= now || expires - now > 630) {
        return new Response(null, {status: 403});
      }
      const used = await this.state.storage.transaction(async tx => {
        const key = 'nonce:' + requestId;
        if (await tx.get(key)) return true;
        await tx.put(key, expires);
        return false;
      });
      if (used) return new Response(null, {status: 409});
      try {
        await this.scheduleBookkeepingSweep();
      } catch {
        // Replay protection has already been committed atomically. Cleanup is
        // best-effort and must never force the caller back onto D1.
      }
      return new Response(null, {status: 201});
    }
    if (role === 'telemetry-dedupe') {
      if (request.method !== 'POST') return new Response(null, {status: 405});
      const fingerprint = request.headers.get('x-citadel-telemetry-fingerprint');
      const expires = Number(request.headers.get('x-citadel-telemetry-expires'));
      const now = Math.floor(Date.now() / 1000);
      if (!/^[a-f0-9]{64}$/.test(fingerprint || '') || !Number.isInteger(expires) ||
          expires <= now || expires - now > 600) {
        return new Response(null, {status: 403});
      }
      const duplicate = await this.state.storage.transaction(async tx => {
        const key = 'telemetry:' + fingerprint;
        const previous = Number(await tx.get(key) || 0);
        if (previous > now) return true;
        await tx.put(key, expires);
        return false;
      });
      if (duplicate) return new Response(null, {status: 409});
      try {
        await this.scheduleBookkeepingSweep();
      } catch {
        // The coalescing claim is only an observability optimization. If alarm
        // maintenance fails, the stored key simply expires on a later cleanup.
      }
      return new Response(null, {status: 201});
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !['agent', 'browser'].includes(role)) {
      return new Response(null, {status: 403});
    }
    const peers = this.sockets(role);
    if (role === 'browser' && (!this.sockets('agent').length || peers.length)) {
      return new Response(null, {status: this.sockets('agent').length ? 409 : 503});
    }
    const jti = request.headers.get('x-citadel-relay-jti');
    const ticketExpires = Number(request.headers.get('x-citadel-relay-ticket-expires'));
    const sessionExpires = Number(request.headers.get('x-citadel-relay-session-expires'));
    if (role === 'browser') {
      if (!/^[a-f0-9-]{36}$/i.test(jti || '') || !Number.isInteger(ticketExpires) ||
          ticketExpires <= Date.now() / 1000 || !Number.isInteger(sessionExpires) ||
          sessionExpires <= ticketExpires || sessionExpires - Date.now() / 1000 > 1800) {
        return new Response(null, {status: 403});
      }
      const used = await this.state.storage.transaction(async tx => {
        if (await tx.get('ticket:' + jti)) return true;
        await tx.put('ticket:' + jti, ticketExpires);
        return false;
      });
      if (used) return new Response(null, {status: 403});
    }
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);
    const info = {role, node_id: request.headers.get('x-citadel-relay-node-id'), jti: role === 'browser' ? jti : null,
      session_exp: role === 'browser' ? sessionExpires : null};
    server.serializeAttachment(info);
    if (role === 'agent') {
      for (const previous of peers) previous.close(4001, 'agent_replaced');
    } else {
      const currentAlarm = await this.state.storage.getAlarm();
      const sessionAlarm = sessionExpires * 1000;
      if (currentAlarm === null || sessionAlarm < currentAlarm) await this.state.storage.setAlarm(sessionAlarm);
      this.sockets('agent')[0]?.send(JSON.stringify({type: 'start', session_id: jti, expires_at: sessionExpires}));
    }
    await this.report(info, 'ssh_' + role + '_connected', {session_id: info.jti});
    return new Response(null, {status: 101, webSocket: client,
      headers: {'sec-websocket-protocol': role === 'agent' ? 'citadel-ssh-agent-v1' : 'citadel-ssh-v1'}});
  }

  webSocketMessage(socket, message) {
    const info = attachment(socket);
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message).length : message.byteLength;
    if (bytes > MAX_FRAME) return socket.close(1009, 'frame_too_large');
    const peer = this.sockets(info.role === 'agent' ? 'browser' : 'agent')[0];
    if (!peer) return;
    if (info.role === 'browser' && info.session_exp * 1000 <= Date.now()) return socket.close(1000, 'session_expired');
    if (peer.bufferedAmount > MAX_BUFFERED) return peer.close(1011, 'receiver_too_slow');
    peer.send(message);
    if (info.role === 'agent' && typeof message === 'string') {
      try {
        const control = JSON.parse(message);
        if (control.type === 'exit' || control.type === 'error') peer.close(1000, 'ssh_finished');
      } catch { /* Binary terminal data and other text controls are forwarded as-is. */ }
    }
  }

  async webSocketClose(socket, code, reason) {
    const info = attachment(socket);
    for (const peer of this.sockets(info.role === 'agent' ? 'browser' : 'agent')) {
      if (info.role === 'agent') peer.close(1011, 'agent_disconnected');
      else peer.send(JSON.stringify({type: 'stop', session_id: info.jti}));
    }
    await this.report(info, 'ssh_' + info.role + '_disconnected', {session_id: info.jti, code, reason});
  }

  async webSocketError(socket) {await this.webSocketClose(socket, 1011, 'websocket_error');}

  async alarm() {
    const now = Date.now() / 1000;
    let next = null;
    for (const browser of this.sockets('browser')) {
      const expires = Number(attachment(browser).session_exp);
      if (Number.isFinite(expires) && expires <= now) browser.close(1000, 'session_expired');
      else if (Number.isFinite(expires)) next = next === null ? expires : Math.min(next, expires);
    }
    let pendingBookkeeping = false;
    const reports = await this.state.storage.list({prefix: 'report:', limit: 20});
    for (const [key, entry] of reports) {
      try {if (!await this.deliverReport(key, entry)) pendingBookkeeping = true;}
      catch {pendingBookkeeping = true;}
    }
    if (reports.size >= 20) pendingBookkeeping = true;
    for (const prefix of ['ticket:', 'nonce:', 'telemetry:']) {
      const rows = await this.state.storage.list({prefix, limit: 1000});
      for (const [key, value] of rows) {
        if (value <= now) await this.state.storage.delete(key);
        else pendingBookkeeping = true;
      }
    }
    // WebSocket session expirations remain exact; expired storage keys are
    // kept until the next bounded sweep, never treated as reusable nonces.
    if (pendingBookkeeping) {
      const sweepAt = now + BOOKKEEPING_SWEEP_SECONDS;
      next = next === null ? sweepAt : Math.min(next, sweepAt);
    }
    if (next !== null) await this.state.storage.setAlarm(next * 1000);
  }
}
