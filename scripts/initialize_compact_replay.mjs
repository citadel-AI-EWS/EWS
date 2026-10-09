import fs from 'node:fs';
import {REPLAY_MIGRATION_ID, REPLAY_DRAIN_SECONDS} from '../src/compact-replay.js';

// Run only AFTER a complete Worker deployment. This is an explicit authority
// migration, never automatic failover after an uncertain nonce claim.
const config = fs.readFileSync('wrangler.jsonc','utf8');
const account = config.match(/"D1_ANALYTICS_ACCOUNT_ID"\s*:\s*"([a-f0-9]+)"/)?.[1];
const database = config.match(/"database_id"\s*:\s*"([a-f0-9-]+)"/)?.[1];
const token = process.env.CLOUDFLARE_API_TOKEN;
const base = process.env.CITADEL_BASE_URL || 'https://citadel-ai.init1.workers.dev';
if (!account || !database || !token) throw Error('replay_migration_configuration_missing');
const release=fs.readFileSync('src/index.js','utf8').split('const LATEST_NODE_RELEASE =')[1].split('const LEGACY_031_BRIDGE_RELEASE')[0];
const coreFiles=[...release.matchAll(/path: "(citadel_node_v[12]\.py)",\s+url: "([^"]+)",\s+sha256: "([a-f0-9]+)"/g)];
if(coreFiles.length!==2) throw Error('replay_repair_release_missing');
for(const [,path,url,expected] of coreFiles) {
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw Error('replay_repair_download_failed');
  const actual=Buffer.from(await crypto.subtle.digest('SHA-256',await response.arrayBuffer())).toString('hex');
  if(actual!==expected) throw Error('replay_repair_release_hash_mismatch');
  console.log(JSON.stringify({test:'immutable-agent-download',path,sha256_verified:true}));
}
async function sql(query, params=[]) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
    method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:JSON.stringify({sql:query,params}),signal:AbortSignal.timeout(15000)});
  const body = await response.json();
  if (!response.ok || !body.success || body.result?.[0]?.success === false) throw Error('replay_migration_database_failed');
  return body.result[0];
}
await sql(`INSERT OR IGNORE INTO node_replay_migrations(migration_id,not_before) VALUES (?,?)`,
  [REPLAY_MIGRATION_ID,Math.floor(Date.now()/1000)+REPLAY_DRAIN_SECONDS]);
const marker = (await sql('SELECT not_before FROM node_replay_migrations WHERE migration_id=?',[REPLAY_MIGRATION_ID])).results[0];
console.log(JSON.stringify({test:'replay-authority-migration',ready_at:new Date(marker.not_before*1000).toISOString()}));
const deadline = Date.now()+720000;
for (;;) {
  if (Date.now()>deadline) throw Error('replay_migration_readiness_timeout');
  let ready=false;
  try {
    const r = await fetch(base+'/api/health',{signal:AbortSignal.timeout(15000)});
    ready = r.ok && (await r.json()).node_control?.status === 'ready';
  } catch {}
  if (ready) break;
  await new Promise(resolve=>setTimeout(resolve,10000));
}

// Isolated paused fixture: no task capability, no command and no workstation
// credentials. It tests the REAL deployed signature boundary and is removed.
const nodeId='node_replay_canary_'+crypto.randomUUID();
const keys=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
const publicKey=JSON.stringify(await crypto.subtle.exportKey('jwk',keys.publicKey));
const now=Math.floor(Date.now()/1000);
async function signed(path,id,ts=now,method='GET',body='') {
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))).toString('hex');
  const signature=Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,
    new TextEncoder().encode([method,path,String(ts),id,hash].join('\n')))).toString('base64url');
  return fetch(base+path,{method,body:method==='GET'?undefined:body,signal:AbortSignal.timeout(15000),headers:{
    'content-type':'application/json','x-node-id':nodeId,'x-node-timestamp':String(ts),
    'x-node-request-id':id,'x-node-signature':signature}});
}
try {
  await sql(`INSERT INTO nodes(node_id,public_key,hostname,os_name,agent_version,status,capabilities_json)
    VALUES (?,?,'test-replay-canary','Linux','0.3.42','paused','[]')`,[nodeId,publicKey]);
  const path=`/api/v1/nodes/${nodeId}/commands`,id=crypto.randomUUID();
  const statuses=[];
  statuses.push((await signed(path,id)).status);
  statuses.push((await signed(path,id)).status);
  // Both control and telemetry MUST claim IDs in the same database authority.
  statuses.push((await signed(`/api/v1/nodes/${nodeId}/logs`,id,now,'POST','{"events":[]}')).status);
  if (JSON.stringify(statuses)!=='[200,409,409]') throw Error('replay_live_canary_failed');
  if (now-marker.not_before<290) {
    const stale=await signed(path,crypto.randomUUID(),marker.not_before-1);
    if (stale.status!==401) throw Error('replay_cutover_signature_not_rejected');
  }
  console.log(JSON.stringify({test:'deployed-signed-replay-canary',ok:true,statuses,backend:'d1_compact'}));
} finally {
  await sql('DELETE FROM nodes WHERE node_id=?',[nodeId]);
}
