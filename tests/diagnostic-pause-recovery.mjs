import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { expiredDiagnosticResumeEligible, DIAGNOSTIC_RESUME_REQUEUE_SQL } from '../src/diagnostic-pause-recovery.js';

const now = Date.parse('2026-10-09T08:00:00Z');
const command = {command_id:'command_diagnostic_resume_'+'a'.repeat(24),command_type:'resume',status:'failed',owned_resume:1,expired_pending:1};
assert.equal(expiredDiagnosticResumeEligible({status:'paused'},command,now),true);
assert.equal(expiredDiagnosticResumeEligible({status:'paused'},{...command,owned_resume:0},now),false);
assert.equal(expiredDiagnosticResumeEligible({status:'paused'},{...command,expired_pending:0},now),false);
assert.equal(expiredDiagnosticResumeEligible({status:'online'},command,now),false);
assert.equal(expiredDiagnosticResumeEligible({status:'paused'},command,Date.parse('2026-10-15T00:00:00Z')),false);

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE nodes(node_id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE commands(command_id TEXT PRIMARY KEY,node_id TEXT,command_type TEXT,signature TEXT,status TEXT,created_at TEXT,completed_at TEXT);
    CREATE TABLE audit_events(actor_type TEXT,actor_id TEXT,action TEXT,target_id TEXT,details_json TEXT);
    INSERT INTO nodes VALUES('fixture','paused');
    INSERT INTO commands VALUES('pause','fixture','pause','signed','completed','2026-10-08T13:44:00Z',NULL);
    INSERT INTO commands VALUES('resume','fixture','resume','original','failed','2026-10-08T18:20:00Z',NULL);
    INSERT INTO audit_events VALUES('controller','diagnostic-pause-20261008','command.queued','resume','{}');
    INSERT INTO audit_events VALUES('controller','controller','command.expired','resume','{"previous_status":"pending","created_at":"2026-10-08T18:20:00Z"}');`);
  return db;
}
const args=['fresh-signature','2026-10-09T08:00:00Z','resume','fixture','2026-10-08T18:20:00Z','2026-10-09T08:00:00Z','pause'];
const db=database();
assert.equal(db.prepare(DIAGNOSTIC_RESUME_REQUEUE_SQL).run(...args).changes,1);
assert.equal(db.prepare(DIAGNOSTIC_RESUME_REQUEUE_SQL).run(...args).changes,0,'duplicate recovery');
assert.equal(db.prepare('SELECT status FROM nodes').get().status,'paused','real acknowledgement required');
assert.equal(db.prepare("SELECT signature FROM commands WHERE command_id='resume'").get().signature,'fresh-signature');
db.close();
for(const kind of ['pause','stop','update']) {
  const raced=database();
  raced.prepare("INSERT INTO commands VALUES('owner','fixture',?,'owner','completed','2026-10-08T19:00:00Z',NULL)").run(kind);
  assert.equal(raced.prepare(DIAGNOSTIC_RESUME_REQUEUE_SQL).run(...args).changes,0,'later owner action wins');
  raced.close();
}
const accepted=database();
accepted.exec("UPDATE audit_events SET details_json='{\"previous_status\":\"accepted\",\"created_at\":\"2026-10-08T18:20:00Z\"}' WHERE action='command.expired'");
assert.equal(accepted.prepare(DIAGNOSTIC_RESUME_REQUEUE_SQL).run(...args).changes,0,'in-flight commands cannot be replayed');
accepted.close();
console.log('Diagnostic pause recovery: fresh signature, normal TTL, owner race and real acknowledgement guards PASS');
