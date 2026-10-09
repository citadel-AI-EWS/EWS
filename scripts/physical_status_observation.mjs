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

async function main() {
  const fleet=(await query("SELECT agent_version,status,COUNT(*) AS count,SUM(CASE WHEN datetime(last_seen_at)>=datetime('now','-5 minutes') THEN 1 ELSE 0 END) AS fresh FROM nodes WHERE status<>'revoked' GROUP BY agent_version,status")).results;
  const rollouts=(await query("SELECT r.target_version,r.status,p.phase,p.pause_reason,p.canary_verified_at FROM agent_rollouts r JOIN agent_rollout_policy p ON p.rollout_id=r.rollout_id WHERE r.status='active' ORDER BY r.created_at DESC LIMIT 2")).results;
  const updates=(await query("SELECT status,COUNT(*) AS count FROM commands WHERE command_type='update' AND json_extract(payload_json,'$.version')='0.3.44' AND datetime(created_at)>=datetime('2026-10-09T19:00:00Z') GROUP BY status")).results;
  const pilot=(await query("SELECT c.command_type,c.status FROM commands c JOIN audit_events a ON a.target_id=c.command_id AND a.action='command.queued' WHERE a.actor_type='controller' AND a.actor_id='authorized-lmstudio-pilot-20261009' ORDER BY c.created_at LIMIT 12")).results;
  const ai=(await query("SELECT a.installed,a.server_running,CASE WHEN json_extract(r.state_json,'$.inference_ready')=1 THEN 1 ELSE 0 END AS inference_ready,json_extract(r.state_json,'$.query_status') AS query_status,CASE WHEN json_extract(r.state_json,'$.query_id') LIKE 'query_audit_lm44_%' AND LENGTH(TRIM(COALESCE(json_extract(r.state_json,'$.query_answer'),'')))>0 THEN 1 ELSE 0 END AS pilot_answer_observed FROM audit_events e JOIN node_ai_state a ON a.node_id=e.target_id LEFT JOIN node_ai_runtime_state r ON r.node_id=a.node_id WHERE e.actor_type='controller' AND e.actor_id='authorized-lmstudio-pilot-20261009' AND e.action='lmstudio.audit.pilot.selected' LIMIT 1")).results;
  console.log(JSON.stringify({test:'physical-system-observation',checked_at:new Date().toISOString(),fleet,rollouts,updates,pilot,ai}));
}
main().catch(()=>{console.log('{"status":"observation_unavailable"}');process.exitCode=2;});
