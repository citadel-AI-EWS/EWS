import {ReplayStoreError} from '../compact-replay.js';
import {replayFailureCode} from '../replay-diagnostics.js';

const states=new WeakMap();
const DAILY_CODES=new Set(['replay_durable_request_limit','replay_durable_duration_limit',
  'replay_storage_daily_write_limit','replay_storage_daily_read_limit']);
export function sshRelayAvailability(env,now=Date.now()) {
  const state=env.SSH_RELAY && states.get(env.SSH_RELAY);
  if(state?.until>now) return {backend:'durable_objects',status:'blocked',error:state.code,
    retry_after_seconds:Math.ceil((state.until-now)/1000),retry_at:new Date(state.until).toISOString()};
  return {backend:'durable_objects',status:state?.verified>now-300000?'ready':'unverified'};
}
export async function invokeSshRelay(env,nodeId,input,options) {
  if(!env.SSH_RELAY) throw new ReplayStoreError(503,'ssh_relay_unavailable',30);
  const current=sshRelayAvailability(env);
  if(current.status==='blocked') throw new ReplayStoreError(503,current.error,current.retry_after_seconds);
  try {
    const response=await env.SSH_RELAY.get(env.SSH_RELAY.idFromName(nodeId)).fetch(input,options);
    if(response.status===101) states.set(env.SSH_RELAY,{verified:Date.now()});
    return response;
  } catch(error) {
    const category=replayFailureCode(error);
    if(DAILY_CODES.has(category)) {
      const now=new Date(),until=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1);
      const code='ssh_'+category.replace('replay_','');
      states.set(env.SSH_RELAY,{until,code});
      throw new ReplayStoreError(503,code,(until-Date.now())/1000);
    }
    throw new ReplayStoreError(503,'ssh_relay_unavailable',30);
  }
}
