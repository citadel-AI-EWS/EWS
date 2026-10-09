import fs from 'node:fs';
import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {failureCode} from './rollout_evidence.mjs';
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
async function main() {
  if(Date.now()>=Date.parse('2026-10-10T00:00:00Z')){console.log('{"status":"diagnostic_lease_expired"}');return;}
  const candidate=(await query(`SELECT r.rollout_id,r.target_version,p.phase,p.pause_reason,n.node_id,n.agent_version,n.status
    FROM agent_rollouts r JOIN agent_rollout_policy p ON p.rollout_id=r.rollout_id
    JOIN nodes n ON n.node_id=p.canary_node_id
    WHERE r.status='active' AND p.phase='paused' AND p.pause_reason='canary_command_failed'
      AND n.status='online' AND datetime(n.last_seen_at)>=datetime('now','-5 minutes')
    ORDER BY datetime(r.created_at) DESC,r.rowid DESC LIMIT 1`)).results[0];
  if(!candidate){console.log('{"status":"no_live_failed_canary"}');return;}
  const version=String(candidate.agent_version).split('.').map(Number);
  if(version[0]!==0||version[1]!==3||version[2]<32){console.log('{"status":"console_not_supported"}');return;}
  const failed=(await query(`SELECT command_id,created_at FROM commands WHERE node_id=? AND command_type='update' AND status='failed'
    ORDER BY datetime(created_at) DESC,rowid DESC LIMIT 1`,[candidate.node_id])).results[0];
  if(!failed){console.log('{"status":"failed_update_not_found"}');return;}
  const acknowledgements=(await query("SELECT details_json FROM audit_events WHERE target_id=? AND action='command.acknowledged' ORDER BY created_at,rowid LIMIT 10",[failed.command_id])).results;
  const ackStatuses=acknowledgements.map(row=>{try{return JSON.parse(row.details_json).status;}catch{return null;}})
    .filter(x=>['accepted','completed','failed','cancelled'].includes(x));
  const commandId='command_audit_logs_'+digest(failed.command_id).slice(0,24);
  const existing=(await query('SELECT status FROM commands WHERE command_id=?',[commandId])).results[0];
  if(!existing) {
    const createdAt=new Date().toISOString(),payload='{"command":"agent-logs"}';
    const canonical=['CITADEL-COMMAND-V1',commandId,candidate.node_id,'ssh_console',digest(payload),createdAt].join('\n');
    const signature=sign(null,Buffer.from(canonical),controllerKey()).toString('base64url');
    await query(`INSERT OR IGNORE INTO commands(command_id,node_id,command_type,payload_json,signature,status,created_at)
      SELECT ?,n.node_id,'ssh_console',?,?,'pending',? FROM nodes n
      JOIN agent_rollout_policy p ON p.canary_node_id=n.node_id
      JOIN agent_rollouts r ON r.rollout_id=p.rollout_id
      WHERE n.node_id=? AND n.status='online' AND datetime(n.last_seen_at)>=datetime('now','-5 minutes')
        AND r.rollout_id=? AND r.status='active' AND p.phase='paused' AND p.pause_reason='canary_command_failed'
        AND NOT EXISTS(SELECT 1 FROM commands c WHERE c.node_id=n.node_id AND c.status IN('pending','accepted'))`,
      [commandId,payload,signature,createdAt,candidate.node_id,candidate.rollout_id]);
    await query(`INSERT INTO audit_events(actor_type,actor_id,action,target_type,target_id,details_json)
      SELECT 'controller','audit-native-console-20261009','command.queued','command',?,'{"command_type":"ssh_console","reason":"read_failed_canary_logs"}'
      WHERE EXISTS(SELECT 1 FROM commands WHERE command_id=?) AND NOT EXISTS(SELECT 1 FROM audit_events WHERE target_id=? AND action='command.queued')`,
      [commandId,commandId,commandId]);
  }
  let result;
  const deadline=Date.now()+150000;
  do {
    result=(await query(`SELECT c.status,r.output,r.exit_code FROM commands c LEFT JOIN ssh_console_results r ON r.command_id=c.command_id WHERE c.command_id=?`,[commandId])).results[0];
    if(!result||!['pending','accepted'].includes(result.status))break;
    await new Promise(resolve=>setTimeout(resolve,10000));
  }while(Date.now()<deadline);
  let matching=null,seen=0;
  // Raw log contents stay in memory, never in public Actions logs or artifacts.
  for(const line of String(result?.output||'').split('\n')) {
    try {
      const event=JSON.parse(line);seen++;
      const detail=event.details||event.data||event;
      if((event.event||event.event_type)==='command_failed'&&detail.command_id===failed.command_id)
        matching=failureCode(detail.error);
    }catch{}
  }
  console.log(JSON.stringify({test:'native-failed-canary-console',checked_at:new Date().toISOString(),
    target_version:candidate.target_version,agent_version:candidate.agent_version,failed_update_acknowledgements:ackStatuses,
    console_status:result?.status||'not_queued',console_exit_code:result?.exit_code??null,
    parsed_log_lines:seen,matching_failure_logged:matching!==null,failure_code:matching}));
  if(result?.status==='pending') {
    await query("UPDATE commands SET status='cancelled',completed_at=CURRENT_TIMESTAMP WHERE command_id=? AND status='pending'",[commandId]);
  }
}
main().catch(error=>{
  const code=/^diagnostic_[a-z_]+$/.test(error?.message||'')?error.message:'diagnostic_unavailable';
  console.log(JSON.stringify({status:'blocked',error:code}));process.exitCode=2;
});

