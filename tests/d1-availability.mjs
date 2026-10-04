import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from '../src/worker.js';
import {withD1Availability, addD1RetryHint} from '../src/d1-availability.js';

let now = Date.UTC(2026, 9, 4, 23, 59, 45);
function database() {
  const calls = [];
  const db = {calls, failure: null,
    prepare(sql) {
      return {sql, args: [], bind(...args) {return {...this, args};},
        async all() {calls.push([sql, this.args]); if (db.failure) throw db.failure; return {results: []};},
        async first() {calls.push([sql, this.args]); if (db.failure) throw db.failure; return null;},
        async run() {calls.push([sql, this.args]); if (db.failure) throw db.failure; return {meta: {changes: 0}};}
      };
    },
    async batch(statements) {return Promise.all(statements.map(statement => statement.run()));}
  };
  return db;
}

const raw = database();
const env = withD1Availability({DB: raw}, () => now);
raw.failure = Error('D1_ERROR: Your account has exceeded the daily row read limit');
await assert.rejects(env.DB.prepare('SELECT 1').all(), /daily row read limit/);
raw.failure = null;
await assert.rejects(env.DB.prepare('SELECT 1').all(), /daily row read limit/);
await assert.rejects(env.DB.prepare('UPDATE nodes SET status = ?').bind('online').run(), /daily row read limit/);
assert.equal(raw.calls.length, 1, 'open quota gate must not query D1 again');
const hinted = await addD1RetryHint(Response.json({ok: false, error: 'hub_d1_daily_read_limit_exceeded'},
  {status: 503}), env);
assert.equal(hinted.headers.get('retry-after'), '15');
assert.equal((await hinted.json()).retry_at, '2026-10-05T00:00:00.000Z');
now += 16000;
await env.DB.prepare('SELECT 1').all();
assert.equal(raw.calls.length, 2, 'gate must reopen automatically at UTC midnight');

const writer = database();
const writeEnv = withD1Availability({DB: writer}, () => now);
writer.failure = Error('D1_ERROR: Your account has exceeded the daily row write limit');
await assert.rejects(writeEnv.DB.prepare('UPDATE nodes SET status = ?').bind('online').run(), /write limit/);
writer.failure = null;
await writeEnv.DB.prepare('SELECT 1').all();
await assert.rejects(writeEnv.DB.prepare('INSERT INTO nodes VALUES (?)').bind('n').run(), /write limit/);
await assert.rejects(writeEnv.DB.batch([writeEnv.DB.prepare('DELETE FROM nodes')]), /write limit/);
assert.equal(writer.calls.length, 2, 'write quota must preserve read-only availability');
await writeEnv.DB.batch([writeEnv.DB.prepare('SELECT ?').bind(42)]);
assert.deepEqual(writer.calls.at(-1), ['SELECT ?', [42]], 'batch must unwrap the real bound statement');

const other = database();
await withD1Availability({DB: other}, () => now).DB.prepare('SELECT 1').all();
assert.equal(other.calls.length, 1, 'quota state must not leak across database bindings');
other.failure = Error('D1_ERROR: database overloaded');
for (let i = 0; i < 2; i++) {
  await assert.rejects(withD1Availability({DB: other}, () => now).DB.prepare('SELECT 1').all(), /overloaded/);
}
assert.equal(other.calls.length, 3, 'transient errors must not pause until midnight');

// Exercise production HTTP handling, including errors caught and scoped by a route.
const blocked = database();
blocked.failure = Error('D1_ERROR: Your account has exceeded the daily row read limit');
const blockedEnv = {DB: blocked};
for (let i = 0; i < 2; i++) {
  const response = await worker.fetch(new Request('https://local.test/api/v1/hub/nodes'), blockedEnv);
  assert.equal(response.status, 503);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  const body = await response.json();
  assert.equal(body.error, 'hub_d1_daily_read_limit_exceeded');
  assert.ok(body.retry_after_seconds > 0);
}
assert.equal(blocked.calls.length, 1);
const unauthenticated = await worker.fetch(new Request('https://local.test/api/v1/nodes/node_test/sync',
  {method: 'POST', body: '{}'}), blockedEnv);
assert.equal(unauthenticated.status, 401, 'quota handling must not bypass authentication');
const telemetry = await worker.fetch(new Request('https://local.test/api/v1/nodes/node_test/logs', {
  method: 'POST', body: '{"events":[]}', headers: {'x-node-id': 'node_test',
    'x-node-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-node-request-id': crypto.randomUUID(), 'x-node-signature': 'invalid'}
}), blockedEnv);
assert.equal(telemetry.status, 503, 'quota failure must not become a generic telemetry HTTP 500');
assert.equal((await telemetry.json()).error, 'controller_d1_daily_read_limit_exceeded');
assert.equal(blocked.calls.length, 1);
const operations = fs.readFileSync('operations.html', 'utf8');
const formatter = operations.match(/function apiErrorText\(d,status\)\{[\s\S]*?\n\}/)[0];
const formatError = vm.runInNewContext('(' + formatter + ')', {errors: {invalid_signature: 'Auth failed'}});
const message = formatError({error: 'controller_d1_daily_read_limit_exceeded',
  retry_at: '2026-10-05T00:00:00Z'}, 503);
assert.match(message, /Свежее состояние компьютеров недоступно/);
assert.match(message, /Повторить после/);
assert.doesNotMatch(formatError({error: 'controller_d1_daily_read_limit_exceeded', retry_at: 'bad date'}, 503), /Invalid Date/);
assert.equal(formatError({error: 'invalid_signature'}, 401), 'Auth failed');
console.log('D1 quota gate, UTC reset, read availability, retry hints and fail-closed HTTP: PASS');
