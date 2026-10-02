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
const token = 'node-management-owner-test';
const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
const env = { ARCHITECT_TOKEN_HASH: await hash(token), DB: {
  prepare: sql => new Statement(sql),
  async batch(statements) { db.exec('BEGIN'); try { const results = []; for (const s of statements) { const stmt=db.prepare(s.sql); if(/^\s*(SELECT|PRAGMA)/i.test(s.sql)) results.push({success:true,results:stmt.all(...s.args),meta:{}}); else results.push({success:true,results:[],meta:{changes:Number(stmt.run(...s.args).changes)}}); } db.exec('COMMIT'); return results; } catch (e) { db.exec('ROLLBACK'); throw e; } }
} };
for (const [id,status] of [['n1','online'],['n2','offline'],['n3','online']]) db.prepare('INSERT INTO nodes (node_id, public_key, hostname, os_name, agent_version, status) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'key-'+id, 'Host '+id, 'linux', '0.3.20', status);
db.exec("INSERT INTO enterprise_sites (site_id, name) VALUES ('site1', 'Existing site'); INSERT INTO enterprise_node_scope (node_id, site_id) VALUES ('n1','site1')");
async function request(path, method='GET', body, credential=token) {
  const response = await controller.fetch(new Request('https://ews.test/api/v1/architect'+path, { method, headers: { authorization: 'Bearer '+credential, 'content-type': 'application/json' }, ...(body ? {body: JSON.stringify(body)} : {}) }), env);
  return { status: response.status, data: await response.json() };
}
let r = await request('/node-groups','POST',{name:'Europe', category:'geography',node_ids:['n1','n2']},''); assert.equal(r.status,401);
r = await request('/node-groups','POST',{name:'Europe', category:'invalid',node_ids:['n1']}); assert.equal(r.status,400);
r = await request('/node-groups','POST',{name:'Europe', category:'geography',node_ids:['n1','missing']}); assert.equal(r.status,404);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM enterprise_node_groups').get().count,0);
r = await request('/node-groups','POST',{name:'Europe',category:'geography',node_ids:['n1','n2','n1']}); assert.equal(r.status,201,JSON.stringify(r.data));const group=r.data.group;
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM enterprise_node_scope WHERE group_id = ?').get(group.group_id).count,2);
assert.equal(db.prepare("SELECT site_id FROM enterprise_node_scope WHERE node_id='n1'").get().site_id,'site1');
r = await request('/node-groups','POST',{name:'Europe',category:'work',node_ids:['n3']}); assert.equal(r.status,409);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM node_group_categories').get().count,1);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM enterprise_node_scope WHERE node_id='n3'").get().count,0);
r=await request('/machines');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.nodes.find(n=>n.node_id==='n2').group_id,group.group_id);assert.equal(r.data.groups[0].category,'geography');
r=await request('/nodes/n2','DELETE',{});assert.equal(r.status,400);
db.prepare("INSERT INTO architect_access_tokens (token_id,token_hash,role,label) VALUES ('operator1',?,'operator','Test')").run(await hash('operator'));
r=await request('/nodes/n2','DELETE',{confirmation:'DELETE_NODE'},'operator');assert.equal(r.status,403);
assert.equal(db.prepare("SELECT status FROM nodes WHERE node_id='n2'").get().status,'offline');
db.exec("INSERT INTO missions (mission_id,title,role_name,mission_type) VALUES ('m1','Test','test','test'); INSERT INTO assignments (assignment_id,mission_id,node_id,status) VALUES ('a1','m1','n3','running')");
r=await request('/nodes/n3','DELETE',{confirmation:'DELETE_NODE'});assert.equal(r.status,409,JSON.stringify(r.data));assert.equal(r.data.error,'node_busy');
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='node.deleted'").get().count,0);
db.exec("UPDATE assignments SET status='completed' WHERE assignment_id='a1'; INSERT INTO commands (command_id,node_id,command_type,signature,status) VALUES ('c1','n3','update','test','pending')");
r=await request('/nodes/n3','DELETE',{confirmation:'DELETE_NODE'});assert.equal(r.status,409);assert.equal(r.data.error,'node_busy');
db.exec("UPDATE commands SET status='completed' WHERE command_id='c1'; INSERT INTO architect_projects (project_id,title,source_type,task_text,task_sha256,checks_json) VALUES ('p1','Test','test','Test','hash','{}'); INSERT INTO project_work_items (work_item_id,project_id,sequence_no,node_id,task_text,status) VALUES ('w1','p1',1,'n3','Test','planned')");
r=await request('/nodes/n3','DELETE',{confirmation:'DELETE_NODE'});assert.equal(r.status,409);assert.equal(r.data.error,'node_busy');
db.exec("UPDATE project_work_items SET status='completed' WHERE work_item_id='w1'");
db.exec("UPDATE assignments SET status='completed' WHERE assignment_id='a1'; INSERT INTO results (result_id,assignment_id,node_id,outcome,summary) VALUES ('r1','a1','n3','success','Preserve me')");
r=await request('/nodes/n3','DELETE',{confirmation:'DELETE_NODE'});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(db.prepare("SELECT summary FROM results WHERE result_id='r1'").get().summary,'Preserve me');
r=await request('/nodes/n2','DELETE',{confirmation:'DELETE_NODE'});assert.equal(r.status,200);
r=await request('/nodes/n2','DELETE',{confirmation:'DELETE_NODE'});assert.equal(r.status,200);
r=await request('/machines');assert.deepEqual(r.data.nodes.map(n=>n.node_id),['n1']);
r=await request('/node-groups','POST',{name:'Revoked',category:'other',node_ids:['n2']});assert.equal(r.status,404);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='node.deleted'").get().count,2);
const publicNodeStatus = async () => {
  const response = await controller.fetch(new Request('https://ews.test/api/v1/hub/nodes'), env);
  assert.equal(response.status, 200);
  return (await response.json()).nodes[0].status;
};
db.prepare("UPDATE nodes SET last_seen_at = '' WHERE node_id = 'n1'").run();
assert.equal(await publicNodeStatus(), 'offline', 'empty heartbeat must not appear online');
db.prepare("UPDATE nodes SET last_seen_at = datetime('now', '-12 hours') WHERE node_id = 'n1'").run();
assert.equal(await publicNodeStatus(), 'offline', 'stale heartbeat must not appear online');
db.prepare("UPDATE nodes SET last_seen_at = CURRENT_TIMESTAMP WHERE node_id = 'n1'").run();
assert.equal(await publicNodeStatus(), 'online', 'fresh heartbeat must appear online');
db.prepare("UPDATE nodes SET status = 'paused' WHERE node_id = 'n1'").run();
assert.equal(await publicNodeStatus(), 'paused', 'explicit paused status must be preserved');
db.close();
console.log('Node management: auth, categories, atomic grouping, site preservation, busy guard, deletion, history and public liveness PASS');
