import assert from 'node:assert/strict';
import {NodeSshRelay} from '../src/ssh/relay.js';

// Model the real alarm/storage contract without waiting ten wall-clock minutes.
// All replay claims still use the durable transaction, never local-only memory.
const actualNow = Date.now;
let nowMs = Date.UTC(2026, 9, 9, 12, 0, 0);
Date.now = () => nowMs;
const store = new Map();
let alarmAt = null;
const scheduled = [];
let alarmCalls = 0;
const storage = {
  async transaction(callback) {
    return callback({
      get: async key => store.get(key),
      put: async (key, value) => {store.set(key, value);}
    });
  },
  async getAlarm() {return alarmAt;},
  async setAlarm(ms) {alarmAt = ms; scheduled.push(ms);},
  async list({prefix}) {return new Map([...store].filter(([key]) => key.startsWith(prefix)));},
  async delete(key) {store.delete(key);}
};
const sockets = [];
const relay = new NodeSshRelay({
  storage,
  getWebSockets() {return sockets;}
});
const nonceRequest = (id, expires = Math.floor(Date.now() / 1000) + 330) =>
  new Request('https://relay.internal/replay-claim', {method: 'POST', headers: {
    'x-citadel-relay-role': 'replay',
    'x-citadel-request-id': id,
    'x-citadel-request-expires': String(expires)
  }});
const telemetryRequest = (fingerprint) => new Request('https://relay.internal/telemetry-dedupe', {
  method: 'POST', headers: {'x-citadel-relay-role': 'telemetry-dedupe',
    'x-citadel-telemetry-fingerprint': fingerprint,
    'x-citadel-telemetry-expires': String(Math.floor(Date.now() / 1000) + 300)}
});

try {
  const first = crypto.randomUUID();
  assert.equal((await relay.fetch(nonceRequest(first))).status, 201);
  assert.equal((await relay.fetch(nonceRequest(first))).status, 409,
    'already claimed nonce must remain rejected');
  assert.equal(scheduled.length, 1);
  assert.equal(alarmAt, nowMs + 600_000, 'cleanup must be scheduled as one 10m sweep');

  for (let i = 1; i < 15; i++) {
    nowMs += 30_000;
    assert.equal((await relay.fetch(nonceRequest(crypto.randomUUID()))).status, 201);
  }
  assert.equal(scheduled.length, 1,
    'replay claims every 30s must not schedule a new alarm for each expiry');

  const fp = 'a'.repeat(64);
  assert.equal((await relay.fetch(telemetryRequest(fp))).status, 201);
  assert.equal((await relay.fetch(telemetryRequest(fp))).status, 409);
  assert.equal(scheduled.length, 1, 'telemetry deduplication shares sweep alarm');

  // A WebSocket session expiry must still take precedence over bookkeeping.
  sockets.push({
    deserializeAttachment: () => ({role: 'browser', session_exp: Math.floor(nowMs / 1000) + 45}),
    close: () => {throw Error('browser closed before session expiry');}
  });
  nowMs = scheduled[0];
  alarmAt = null; // Cloudflare clears a triggered alarm before invoking alarm().
  sockets.length = 0;
  const keysBefore = store.size;
  await relay.alarm();
  alarmCalls += 1;
  assert.ok(store.size < keysBefore, 'expired replay keys should be pruned on sweep');
  assert.ok(store.size > 0, 'unexpired keys must survive a sweep');
  assert.equal(alarmAt, nowMs + 600_000, 'pending storage should trigger one more 10m sweep');

  const browser = {
    deserializeAttachment: () => ({role: 'browser', session_exp: Math.floor(nowMs / 1000) + 50}),
    close: () => {throw Error('browser closed too soon');}
  };
  sockets.push(browser);
  alarmAt = null;
  await relay.alarm();
  alarmCalls += 1;
  assert.equal(alarmAt, nowMs + 50_000, 'browser session expiry must never be delayed');

  // The next sweep clears the remaining keys and stops scheduling idle alarms.
  sockets.length = 0;
  nowMs += 610_000;
  alarmAt = null;
  await relay.alarm();
  alarmCalls += 1;
  assert.equal(store.size, 0);
  assert.equal(alarmAt, null, 'empty relay should not generate recurring alarms');
  assert.equal(alarmCalls, 3);
  console.log('Durable Objects replay/telemetry cleanup: batched alarms and session priority PASS');
} finally {
  Date.now = actualNow;
}
