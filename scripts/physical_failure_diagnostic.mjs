import fs from 'node:fs';
import {failureCode} from './rollout_evidence.mjs';
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


function classify(value) {
  const text=String(value||'');
  if(/running scripts.{0,80}disabled|not digitally signed|PSSecurityException|ExecutionPolicy|AuthorizationManager|выполнение.{0,80}сценари.{0,80}отключено/i.test(text))return 'powershell_execution_policy';
  if(/lms CLI unavailable after installation/i.test(text))return 'lms_missing_after_install';
  if(/lmstudio installer helper hash mismatch/i.test(text))return 'installer_helper_hash_mismatch';
  if(/PowerShell unavailable/i.test(text))return 'powershell_unavailable';
  if(/underlying connection.{0,40}closed|SSL\/TLS secure channel|Invoke-WebRequest/i.test(text))return 'upstream_installer_download_failed';
  return failureCode(text);
}
async function main() {
  if(Date.now()>=Date.parse('2026-10-10T00:00:00Z')){console.log('{"status":"diagnostic_lease_expired"}');return;}
  const failures=(await query(`SELECT c.command_id,c.node_id,c.command_type,n.agent_version FROM commands c JOIN nodes n ON n.node_id=c.node_id
    WHERE c.status='failed' AND datetime(c.created_at)>=datetime('2026-10-09T19:00:00Z') AND
      ((c.command_type='update' AND json_extract(c.payload_json,'$.version')='0.3.44') OR
       (c.command_type='lmstudio_install' AND EXISTS(SELECT 1 FROM audit_events a WHERE a.target_id=c.command_id AND a.actor_id='authorized-lmstudio-pilot-20261009')))
    ORDER BY c.created_at DESC LIMIT 5`)).results;
  for(const failed of failures) {
    const events=(await query("SELECT event_type,details_json FROM node_logs WHERE node_id=? AND event_type='command_failed' ORDER BY created_at DESC LIMIT 100",[failed.node_id])).results;
    let code=null;
    for(const row of events){try{const details=JSON.parse(row.details_json);if(details.command_id===failed.command_id){code=classify(details.error);break;}}catch{}}
    const patch=Number(String(failed.agent_version).split('.')[2]);
    if(patch>=32) {
      const id='command_audit_read_failure_'+digest(failed.command_id).slice(0,24),payload='{"command":"agent-logs"}',createdAt=new Date().toISOString();
      const signature=sign(null,Buffer.from(['CITADEL-COMMAND-V1',id,failed.node_id,'ssh_console',digest(payload),createdAt].join('\n')),controllerKey()).toString('base64url');
      await query(`INSERT OR IGNORE INTO commands(command_id,node_id,command_type,payload_json,signature,status,created_at)
        SELECT ?,node_id,'ssh_console',?,?,'pending',? FROM nodes n WHERE node_id=? AND status='online'
          AND datetime(last_seen_at)>=datetime('now','-5 minutes')
          AND NOT EXISTS(SELECT 1 FROM commands c WHERE c.node_id=n.node_id AND c.status IN('pending','accepted'))`,
        [id,payload,signature,createdAt,failed.node_id]);
      let result;const deadline=Date.now()+90000;
      do {
        result=(await query("SELECT c.status,r.output FROM commands c LEFT JOIN ssh_console_results r ON r.command_id=c.command_id WHERE c.command_id=?",[id])).results[0];
        if(!result||!['pending','accepted'].includes(result.status))break;
        await new Promise(resolve=>setTimeout(resolve,5000));
      }while(Date.now()<deadline);
      for(const line of String(result?.output||'').split('\n')){try{const event=JSON.parse(line);
        if(event.event==='command_failed'&&event.command_id===failed.command_id)code=classify(event.error);
      }catch{}}
      if(result?.status==='pending')await query("UPDATE commands SET status='cancelled',completed_at=CURRENT_TIMESTAMP WHERE command_id=? AND status='pending'",[id]);
    }
    console.log(JSON.stringify({test:'physical-failure-reason',command_type:failed.command_type,agent_version:failed.agent_version,failure_code:code}));
  }
}
main().catch(()=>{console.log('{"status":"diagnostic_unavailable"}');process.exitCode=2;});
