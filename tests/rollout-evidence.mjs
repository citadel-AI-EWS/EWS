import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failureCode, summarizeFailure, eligibleDiagnosticPause, resumeSql } from '../scripts/rollout_evidence.mjs';

assert.equal(failureCode('updated agent startup health-check failed at C:\\private\\agent'), 'startup_healthcheck_failed');
assert.equal(failureCode('update download failed: HTTP 403'), 'download_http_403');
assert.equal(failureCode('[WinError 5] Access is denied: private file'), 'file_access_denied');
assert.equal(failureCode('unknown secret url https://private.invalid/?token=credential'), 'unclassified_error');
const history = [{ event_type: 'command_failed', created_at: '2026-10-08T13:31:59Z',
  details_json: JSON.stringify({ command_id: 'previous', error: 'updated agent self-test failed' }) }];
assert.equal(summarizeFailure(history, 'current').matching_failure_logged, false);
assert.equal(summarizeFailure(history, 'previous').failure_code, 'self_test_failed');

const node = { node_id: 'node_fixture', status: 'paused' };
const pause = { command_id: 'command_pause', command_type: 'pause', status: 'completed', created_at: '2026-10-08T13:44:00Z' };
const hash = createHash('sha256').update(node.node_id).digest('hex');
const now = Date.parse('2026-10-08T18:00:00Z');
assert.equal(eligibleDiagnosticPause(node, pause, hash, now), true);
assert.equal(eligibleDiagnosticPause(node, { ...pause, created_at: '2026-10-08T15:00:00Z' }, hash, now), false);
assert.equal(eligibleDiagnosticPause(node, { ...pause, command_type: 'stop' }, hash, now), false);
assert.equal(eligibleDiagnosticPause({ ...node, node_id: 'node_other' }, pause, hash, now), false);
assert.equal(eligibleDiagnosticPause(node, pause, hash, Date.parse('2026-10-09T00:00:00Z')), false);

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE nodes (node_id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE commands (command_id TEXT PRIMARY KEY,node_id TEXT,command_type TEXT,payload_json TEXT,signature TEXT,status TEXT,created_at TEXT);
    CREATE TABLE audit_events (actor_type TEXT,actor_id TEXT,action TEXT,target_type TEXT,target_id TEXT,details_json TEXT);
    INSERT INTO nodes VALUES ('node_fixture','paused');
    INSERT INTO commands VALUES ('command_pause','node_fixture','pause','{}','original','completed','2026-10-08T13:44:00Z');`);
  return db;
}
const command = { commandId: 'command_resume', nodeId: node.node_id, pauseId: pause.command_id,
  createdAt: '2026-10-08T18:00:00Z', signature: 'signed_fixture' };
const db = database();
db.exec(resumeSql(command)); db.exec(resumeSql(command));
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM commands WHERE command_type='resume'").get().count, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);
assert.equal(db.prepare('SELECT status FROM nodes').get().status, 'paused', 'resume must be confirmed by the real node');
db.close();
for (const [kind, status] of [['stop', 'completed'], ['pause', 'completed'], ['update', 'pending']]) {
  const racing = database();
  racing.prepare("INSERT INTO commands VALUES ('newer','node_fixture',?,'{}','newer',?,'2026-10-08T17:00:00Z')").run(kind, status);
  racing.exec(resumeSql(command));
  assert.equal(racing.prepare("SELECT COUNT(*) AS count FROM commands WHERE command_type='resume'").get().count, 0);
  racing.close();
}
console.log('Bounded rollout evidence: privacy, command correlation, exact pause lease, owner-race and real acknowledgement guards PASS');
