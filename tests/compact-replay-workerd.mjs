import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {REPLAY_MIGRATION_ID} from '../src/compact-replay.js';

const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
  import worker from './src/worker.js';
  export default {async fetch(request,env,ctx) {
    let writes=0;
    const record=r=>{writes+=Number(r?.meta?.rows_written||0);return r;};
    class Statement {
      constructor(inner){this.inner=inner;}
      bind(...args){return new Statement(this.inner.bind(...args));}
      async first(...args){const r=record(await this.inner.all(...args));return r.results?.[0]||null;}
      async all(...args){return record(await this.inner.all(...args));}
      async run(...args){return record(await this.inner.run(...args));}
    }
    const DB={prepare:sql=>new Statement(env.DB.prepare(sql)),
      batch:async stmts=>(await env.DB.batch(stmts.map(s=>s.inner))).map(record)};
    const SSH_RELAY={idFromName:x=>x,get:()=>{throw Error('exhausted DO must not be called for node auth');}};
    const response=await worker.fetch(request,{...env,DB,SSH_RELAY,NODE_REPLAY_BACKEND:'d1_compact'},ctx);
    const output=new Response(response.body,response);output.headers.set('x-test-writes',String(writes));return output;
  }};
`},bundle:true,format:'esm',write:false});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,
  compatibilityDate:'2026-09-05',d1Databases:['DB']}));
try {
  const db=await mf.getD1Database('DB');
  for(const file of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()) {
    for(const sql of fs.readFileSync('migrations/'+file,'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))
      await db.prepare(sql).run();
  }
  const keys=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
  const enrollment=await mf.dispatchFetch('https://local.test/api/v1/enroll',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({public_key:await crypto.subtle.exportKey('jwk',keys.publicKey),hostname:'audit-worker',os_name:'Linux',
      agent_version:'0.3.42',capabilities:['architect_python']})});
  assert.equal(enrollment.status,201,await enrollment.clone().text());
  const node=(await enrollment.json()).node;
  assert.equal(node.status,'paused','an unapproved public registration cannot become a task worker');
  const now=Math.floor(Date.now()/1000);
  async function request(path,id=crypto.randomUUID(),ts=now,method='GET',body='') {
    const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))).toString('hex');
    const signature=Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,
      new TextEncoder().encode([method,path,String(ts),id,hash].join('\n')))).toString('base64url');
    return mf.dispatchFetch('https://local.test'+path,{method,body:method==='GET'?undefined:body,
      headers:{'content-type':'application/json','x-node-id':node.node_id,'x-node-timestamp':String(ts),
        'x-node-request-id':id,'x-node-signature':signature}});
  }
  const path=`/api/v1/nodes/${node.node_id}/commands`;
  let response=await request(path);
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,'node_replay_awaiting_migration');
  await db.prepare('INSERT INTO node_replay_migrations VALUES (?,?)').bind(REPLAY_MIGRATION_ID,now+630).run();
  response=await request(path);
  assert.equal(response.status,503);assert.ok(Number(response.headers.get('retry-after'))>=600);
  await db.prepare('UPDATE node_replay_migrations SET not_before=?').bind(now-10).run();
  response=await request(path,crypto.randomUUID(),now-11);
  assert.equal(response.status,401);assert.equal((await response.json()).error,'signature_before_replay_cutover');
  const id=crypto.randomUUID();
  response=await request(path,id);
  assert.equal(response.status,200,await response.clone().text());
  assert.equal(Number(response.headers.get('x-test-writes')),1,'idle authentication writes one compact row');
  assert.equal((await request(path,id)).status,409);
  assert.equal((await request(`/api/v1/nodes/${node.node_id}/logs`,id,now,'POST','{"events":[]}')).status,409,
    'telemetry and control share the same authority');
  const concurrent=crypto.randomUUID();
  const outcomes=await Promise.all(Array.from({length:5},async()=> (await request(path,concurrent)).status));
  assert.deepEqual(outcomes.sort(),[200,409,409,409,409]);
  response=await request(`/api/v1/nodes/${node.node_id}/sync`,crypto.randomUUID(),now,'POST',
    '{"heartbeat":{"agent_version":"0.3.42"}}');
  assert.equal(response.status,200,await response.clone().text());
  const synced=await response.json();assert.equal(synced.node_status,'paused');assert.deepEqual(synced.assignments,[]);
  assert.equal(synced.idle_poll_seconds,90);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM node_request_nonces').first()).n,0);
  response=await mf.dispatchFetch('https://local.test/api/readiness');
  assert.equal(response.status,503);
  const readiness=await response.json();assert.equal(readiness.ready,false);assert.equal(readiness.node_control.status,'ready');
  assert.ok(readiness.readiness_failures.includes('google_drive_payloads'));
  await db.prepare('DELETE FROM nodes WHERE node_id=?').bind(node.node_id).run();
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM node_replay_windows').first()).n,0);
  console.log('Actual workerd/D1: explicit drain, shared replay authority, concurrent claims, 1-row idle write, approval and readiness PASS');
} finally {await mf.dispose();}
