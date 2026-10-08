import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {patchedRolloutEligible,recoverPatchedRollout as recover} from '../src/patched-rollout-recovery.js';

const now=Date.parse('2026-10-08T19:00:00Z'), stamp=ago=>new Date(now-ago).toISOString();
const recoverPatchedRollout=(...args)=>recover(...args,now);
const release={version:'0.3.41',files:[]};
assert.equal(patchedRolloutEligible({target_version:'0.3.40'},release,Date.parse('2026-10-08T19:00:00Z')),true);
assert.equal(patchedRolloutEligible({target_version:'0.3.40'},release,Date.parse('2026-10-15T00:00:00Z')),false);
assert.equal(patchedRolloutEligible({target_version:'0.3.41'},release),false);
assert.equal(patchedRolloutEligible({target_version:'0.3.40'},{version:'0.3.42'}),false);

function fixture({status='online',seen=stamp(1000),command=null,reason='canary_command_failed'}={}) {
  const sql=new DatabaseSync(':memory:');
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE nodes(node_id TEXT PRIMARY KEY,hostname TEXT,status TEXT,agent_version TEXT,last_seen_at TEXT);
    CREATE TABLE commands(node_id TEXT,command_type TEXT,status TEXT,created_at TEXT);
    CREATE TABLE agent_rollouts(rollout_id TEXT PRIMARY KEY,target_version TEXT,release_json TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    CREATE UNIQUE INDEX active_rollout ON agent_rollouts(status) WHERE status='active';
    CREATE TABLE agent_rollout_policy(rollout_id TEXT PRIMARY KEY REFERENCES agent_rollouts(rollout_id),
      canary_node_id TEXT REFERENCES nodes(node_id),phase TEXT,max_parallel INTEGER,max_failures INTEGER,pause_reason TEXT);
    CREATE TABLE audit_events(actor_type TEXT,actor_id TEXT,action TEXT,target_type TEXT,target_id TEXT,details_json TEXT);`);
  sql.prepare('INSERT INTO nodes VALUES(?,?,?,?,?)').run('candidate','a19',status,'0.3.24',seen);
  sql.prepare('INSERT INTO nodes VALUES(?,?,?,?,?)').run('failed','a23','offline','0.3.24',stamp(3600000));
  sql.prepare('INSERT INTO agent_rollouts VALUES(?,?,?,?,?,?)').run('old','0.3.40','{}','active',stamp(3600000),stamp(3600000));
  sql.prepare('INSERT INTO agent_rollout_policy VALUES(?,?,?,?,?,?)').run('old','failed','paused',3,2,reason);
  sql.exec("INSERT INTO audit_events VALUES('architect','fixture','agent.rollout.started','rollout','old','{}')");
  if(command) sql.prepare('INSERT INTO commands VALUES(?,?,?,?)').run('candidate','update',command,stamp(2000));
  const db={prepare(text){
    return {bind(...args){
      return {text,args,
        async first(){return sql.prepare(text).get(...args)||null;},
        async run(){return {meta:{changes:sql.prepare(text).run(...args).changes}};}
      };
    }};
  },
    async batch(statements){
      sql.exec('BEGIN');
      try{const result=[];for(const s of statements) result.push(await s.run());sql.exec('COMMIT');return result;}
      catch(error){sql.exec('ROLLBACK');throw error;}
    }};
  return{sql,env:{DB:db},rollout:sql.prepare("SELECT * FROM agent_rollouts WHERE rollout_id='old'").get()};
}
const canary=(node,policy)=>Boolean(node&&node.node_id!==policy.canary_node_id&&node.hostname==='a19');
const good=fixture();
const promoted=await recoverPatchedRollout(good.env,good.rollout,release,'candidate',canary);
assert.equal(promoted.target_version,'0.3.41');
assert.equal(good.sql.prepare("SELECT target_version,status FROM agent_rollouts WHERE rollout_id='old'").get().status,'completed');
assert.equal(good.sql.prepare("SELECT phase FROM agent_rollout_policy WHERE rollout_id=?").get(promoted.rollout_id).phase,'canary');
assert.equal(good.sql.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,2);
const repeated=await recoverPatchedRollout(good.env,good.rollout,release,'candidate',canary);
assert.equal(repeated.rollout_id,'old');
assert.equal(good.sql.prepare('SELECT COUNT(*) AS n FROM agent_rollouts').get().n,2,'idempotent replacement');
assert.equal(good.sql.prepare('SELECT COUNT(*) AS n FROM commands').get().n,0,'normal signed command path must execute the update');
good.sql.close();
for(const options of [{status:'paused'},{status:'offline'},{seen:stamp(600000)},
  {command:'pending'},{command:'accepted'},{reason:'owner_pause'}]) {
  const f=fixture(options);
  const result=await recoverPatchedRollout(f.env,f.rollout,release,'candidate',canary);
  assert.equal(result.rollout_id,'old',JSON.stringify(options));
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM agent_rollouts').get().n,1);
  f.sql.close();
}
for (const status of ['pending','accepted']) {
  const f=fixture();
  f.sql.prepare('INSERT INTO commands VALUES(?,?,?,?)').run('failed','update',status,stamp(2000));
  assert.equal((await recoverPatchedRollout(f.env,f.rollout,release,'candidate',canary)).rollout_id,'old',
    `another node's ${status} update must drain before replacement`);
  f.sql.prepare("UPDATE commands SET status='completed'").run();
  assert.equal((await recoverPatchedRollout(f.env,f.rollout,release,'candidate',canary)).target_version,'0.3.41');
  f.sql.close();
}
const stale=fixture();
stale.sql.prepare('INSERT INTO commands VALUES(?,?,?,?)').run('failed','update','accepted',stamp(1200000));
assert.equal((await recoverPatchedRollout(stale.env,stale.rollout,release,'candidate',canary)).rollout_id,'old',
  'an old accepted command is blocked until normal expiry has actually retired it');
let expiryCalled=0;
const expire=async()=>{
  expiryCalled++;
  stale.sql.prepare("UPDATE commands SET status='failed' WHERE datetime(created_at)<datetime(?,'-15 minutes')").run(stamp(0));
};
assert.equal((await recover(stale.env,stale.rollout,release,'candidate',canary,now,expire)).target_version,'0.3.41');
assert.equal(expiryCalled,1);
stale.sql.close();
const owner=fixture();
owner.sql.exec("UPDATE agent_rollouts SET status='cancelled' WHERE rollout_id='old'");
assert.equal((await recoverPatchedRollout(owner.env,owner.rollout,release,'candidate',canary)).rollout_id,'old');
assert.equal(owner.sql.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,1,'owner cancellation wins');
owner.sql.close();
const failed=fixture();
assert.equal((await recoverPatchedRollout(failed.env,failed.rollout,release,'failed',canary)).rollout_id,'old');
failed.sql.close();
const unauthorized=fixture();
unauthorized.sql.exec('DELETE FROM audit_events');
assert.equal((await recoverPatchedRollout(unauthorized.env,unauthorized.rollout,release,'candidate',canary)).rollout_id,'old');
unauthorized.sql.close();
console.log('Patched rollout recovery: live alternative canary, preserved history/limits, owner commands and atomic idempotency PASS');
