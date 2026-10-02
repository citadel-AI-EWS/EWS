import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import controller from '../src/index.js';

// Execute the real SQL against SQLite, including D1's transactional batch semantics.
const db = new DatabaseSync(':memory:');
for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + name, 'utf8'));
class Statement {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async all() { return { success: true, results: db.prepare(this.sql).all(...this.args), meta: {} }; }
  async first(column) { const row = db.prepare(this.sql).get(...this.args); return row ? column ? row[column] : row : null; }
  async run() { const r = db.prepare(this.sql).run(...this.args); return { success: true, results: [], meta: { changes: Number(r.changes) } }; }
}
const token = 'legacy-command-test';
const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
const env = { ARCHITECT_TOKEN_HASH: await hash(token), DB: {
  prepare: sql => new Statement(sql),
  async batch(statements) { db.exec('BEGIN'); try { const results = []; for (const s of statements) { const stmt=db.prepare(s.sql); if(/^\s*(SELECT|PRAGMA)/i.test(s.sql)) results.push({success:true,results:stmt.all(...s.args),meta:{}}); else results.push({success:true,results:[],meta:{changes:Number(stmt.run(...s.args).changes)}}); } db.exec('COMMIT'); return results; } catch (e) { db.exec('ROLLBACK'); throw e; } }
} };
db.exec("DROP INDEX IF EXISTS idx_commands_one_active_per_node");
db.prepare("INSERT INTO nodes (node_id, public_key, hostname, os_name, agent_version) VALUES ('n1', 'test-key', 'Test', 'Linux', '0.3.28')").run();
const timestamp = new Date().toISOString().slice(0,19);
const insert = db.prepare("INSERT INTO commands (command_id,node_id,command_type,signature,status,created_at) VALUES (?, 'n1','pause','test','pending',?)");
insert.run('command_a', timestamp.replace('T',' '));
insert.run('command_z', timestamp+'Z');
const response = await controller.fetch(new Request('https://ews.test/api/v1/architect/nodes/n1/commands', {
  method:'POST', headers:{authorization:'Bearer '+token,'content-type':'application/json'},
  body:JSON.stringify({command_type:'lmstudio_probe'})
}), env);
assert.equal(response.status, 409, JSON.stringify(await response.clone().json()));
const rows = db.prepare('SELECT command_id,status,completed_at FROM commands ORDER BY command_id').all();
assert.equal(rows[0].status,'failed');
assert.ok(rows[0].completed_at);
assert.equal(rows[1].status,'pending');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='commands.active_duplicates_repaired'").get().n,1);
assert.throws(()=>insert.run('command_other',timestamp),/UNIQUE/);
db.close();
console.log('Legacy command repair: mixed timestamp ties, preserved newest command, restored unique index and audit PASS');
