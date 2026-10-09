import fs from 'node:fs';
import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
const publicX='erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0';
const config=fs.readFileSync('wrangler.jsonc','utf8');
const account=config.match(/"D1_ANALYTICS_ACCOUNT_ID"\s*:\s*"([^"]+)"/)?.[1];
const database=config.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1];
const digest=value=>createHash('sha256').update(value).digest('hex');
async function query(sql,params=[]) {
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,{
    method:'POST',headers:{authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},
    body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(15000)});
  const body=await response.json();
  if(!response.ok||!body.success||body.result?.[0]?.success===false)throw Error('diagnostic_database_unavailable');
  return body.result[0];
}
function controllerKey() {
  let encoded=String(process.env.CONTROLLER_COMMAND_PRIVATE_JWK||'').trim().replace(/^\x60\x60\x60(?:json)?\s*/i,'').replace(/\s*\x60\x60\x60$/,'');
  let jwk=JSON.parse(encoded);if(typeof jwk==='string')jwk=JSON.parse(jwk);
  if(jwk?.kty!=='OKP'||jwk.crv!=='Ed25519'||jwk.x!==publicX||typeof jwk.d!=='string')throw Error('diagnostic_signing_key_unavailable');
  const key=createPrivateKey({key:{kty:'OKP',crv:'Ed25519',x:jwk.x,d:jwk.d},format:'jwk'});
  if(createPublicKey(key).export({format:'jwk'}).x!==publicX)throw Error('diagnostic_signing_key_unavailable');
  return key;
}

const expires=Date.parse('2026-10-10T00:00:00Z');
async function command(node,type,payload,timeout=120000) {
  if(Date.now()>=expires)throw Error('diagnostic_lease_expired');
  const id='command_audit_lm44_'+digest(node.node_id+type).slice(0,24);
  const serialized=JSON.stringify(payload),createdAt=new Date().toISOString();
  const signature=sign(null,Buffer.from(['CITADEL-COMMAND-V1',id,node.node_id,type,digest(serialized),createdAt].join('\n')),controllerKey()).toString('base64url');
  await query(`INSERT OR IGNORE INTO commands(command_id,node_id,command_type,payload_json,signature,status,created_at)
    SELECT ?,node_id,?,?,?,'pending',? FROM nodes n WHERE node_id=? AND status='online'
      AND agent_version='0.3.44' AND datetime(last_seen_at)>=datetime('now','-5 minutes')
      AND NOT EXISTS(SELECT 1 FROM commands c WHERE c.node_id=n.node_id AND c.status IN('pending','accepted'))`,
    [id,type,serialized,signature,createdAt,node.node_id]);
  await query(`INSERT INTO audit_events(actor_type,actor_id,action,target_type,target_id,details_json)
    SELECT 'controller','authorized-lmstudio-pilot-20261009','command.queued','command',?,?
    WHERE EXISTS(SELECT 1 FROM commands WHERE command_id=?) AND NOT EXISTS(SELECT 1 FROM audit_events WHERE target_id=? AND action='command.queued')`,
    [id,JSON.stringify({command_type:type,reason:'physical_lmstudio_verification'}),id,id]);
  let result;const deadline=Math.min(Date.now()+timeout,expires);
  do {
    result=(await query('SELECT status FROM commands WHERE command_id=?',[id])).results[0];
    if(!result||!['pending','accepted'].includes(result.status))break;
    await new Promise(resolve=>setTimeout(resolve,5000));
  }while(Date.now()<deadline);
  console.log(JSON.stringify({test:'physical-signed-command',command_type:type,status:result?.status||'not_queued'}));
  if(result?.status==='pending')await query("UPDATE commands SET status='cancelled',completed_at=CURRENT_TIMESTAMP WHERE command_id=? AND status='pending'",[id]);
  return result?.status==='completed';
}
async function main() {
  if(Date.now()>=expires){console.log('{"status":"diagnostic_lease_expired"}');return;}
  console.log(JSON.stringify({test:'physical-fleet-versions',checked_at:new Date().toISOString(),
    nodes:(await query(`SELECT agent_version,status,COUNT(*) AS count,
      SUM(CASE WHEN datetime(last_seen_at)>=datetime('now','-5 minutes') THEN 1 ELSE 0 END) AS fresh
      FROM nodes WHERE status<>'revoked' GROUP BY agent_version,status`)).results,
    rollouts:(await query(`SELECT r.target_version,r.status,p.phase,p.pause_reason FROM agent_rollouts r
      JOIN agent_rollout_policy p ON p.rollout_id=r.rollout_id WHERE r.status='active' LIMIT 3`)).results}));
  const previous=(await query("SELECT target_id FROM audit_events WHERE actor_type='controller' AND actor_id='authorized-lmstudio-pilot-20261009' AND action='lmstudio.audit.pilot.selected' ORDER BY rowid LIMIT 1")).results[0];
  let node;const until=Math.min(Date.now()+300000,expires);
  do {
    if(previous) {
      node=(await query("SELECT node_id,os_name FROM nodes WHERE node_id=? AND status='online' AND agent_version='0.3.44' AND datetime(last_seen_at)>=datetime('now','-5 minutes')",[previous.target_id])).results[0];
      if(!node){console.log('{"status":"pilot_not_ready"}');return;}
      break;
    }
    node=(await query(`SELECT n.node_id,n.os_name FROM nodes n JOIN node_hardware_state h ON h.node_id=n.node_id
      LEFT JOIN node_ai_state a ON a.node_id=n.node_id
      WHERE n.status='online' AND n.agent_version='0.3.44' AND datetime(n.last_seen_at)>=datetime('now','-5 minutes')
        AND h.memory_total_bytes>=2147483648 AND COALESCE(a.loaded_model,'')=''
        AND NOT EXISTS(SELECT 1 FROM commands c WHERE c.node_id=n.node_id AND c.status IN('pending','accepted'))
      ORDER BY n.enrolled_at,n.node_id LIMIT 1`)).results[0];
    if(node)break;
    await new Promise(resolve=>setTimeout(resolve,30000));
  }while(Date.now()<until);
  if(!node){console.log('{"status":"awaiting_updated_idle_node"}');return;}
  await query("INSERT INTO audit_events(actor_type,actor_id,action,target_type,target_id,details_json) SELECT 'controller','authorized-lmstudio-pilot-20261009','lmstudio.audit.pilot.selected','node',?,'{}' WHERE NOT EXISTS(SELECT 1 FROM audit_events WHERE actor_type='controller' AND actor_id='authorized-lmstudio-pilot-20261009' AND action='lmstudio.audit.pilot.selected')",[node.node_id]);
  const selected=(await query("SELECT target_id FROM audit_events WHERE actor_type='controller' AND actor_id='authorized-lmstudio-pilot-20261009' AND action='lmstudio.audit.pilot.selected' ORDER BY rowid LIMIT 1")).results[0];
  if(selected?.target_id!==node.node_id){console.log('{"status":"pilot_already_selected"}');return;}
  if(!await command(node,'ssh_console',{command:'help'}))return;
  if(!await command(node,'lmstudio_probe',{}))return;
  const observed=(await query('SELECT installed,server_running FROM node_ai_state WHERE node_id=?',[node.node_id])).results[0];
  if(!observed?.installed||!observed?.server_running) {
    const windows=String(node.os_name).toLowerCase().includes('windows');
    if(!windows&&!String(node.os_name).toLowerCase().includes('linux'))throw Error('diagnostic_platform_unsupported');
    const path='install_llmstudio_headless.'+(windows?'ps1':'sh');
    const asset={path,url:'https://raw.githubusercontent.com/citadel-AI-EWS/EWS/a9b18e14b1ba1996e896e359b1a019c800572c30/agent/lmstudio/'+path,
      sha256:digest(fs.readFileSync('agent/lmstudio/'+path))};
    if(!await command(node,'lmstudio_install',{asset},300000))return;
  }
  const model={model:'lmstudio-community/Qwen2.5-0.5B-Instruct-GGUF',source:'huggingface',quantization:'Q4_K_M'};
  if(!await command(node,'lmstudio_model_get',model,300000))return;
  if(!await command(node,'lmstudio_model_load',{...model,settings:{context_length:2048}},120000))return;
  const requestId='query_audit_lm44_'+digest(node.node_id).slice(0,16);
  if(!await command(node,'hybrid_query',{request_id:requestId,mode:'lmstudio',prompt:'Reply with the single word hi.',
    settings:{temperature:0,max_output_tokens:16}},120000))return;
  const row=(await query('SELECT state_json FROM node_ai_runtime_state WHERE node_id=?',[node.node_id])).results[0];
  const state=JSON.parse(row?.state_json||'{}');
  console.log(JSON.stringify({test:'physical-lmstudio-inference',agent_version:'0.3.44',
    query_matches:state.query_id===requestId,status:state.query_status,
    answer_nonempty:typeof state.query_answer==='string'&&state.query_answer.trim().length>0,
    inference_ready:Number(state.inference_ready)===1,server_running:Number(state.server_running)===1}));
}
main().catch(error=>{
  const code=/^diagnostic_[a-z_]+$/.test(error?.message||'')?error.message:'diagnostic_unavailable';
  console.log(JSON.stringify({status:'blocked',error:code}));process.exitCode=2;
});
