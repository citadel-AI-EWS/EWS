import assert from 'node:assert/strict';
import { controllerSshAccess } from '../src/index.js';
const node = 'node_123';
assert.deepEqual(controllerSshAccess({}, node), {hostname:null, mode:'none'});
assert.deepEqual(controllerSshAccess({SSH_ACCESS_HOSTS_JSON:JSON.stringify({[node]:{hostname:'terminal.example.com',mode:'browser'}})},node), {hostname:'terminal.example.com',mode:'browser'});
assert.deepEqual(controllerSshAccess({SSH_ACCESS_HOSTS_JSON:JSON.stringify({[node]:{hostname:'ssh.example.com',mode:'infrastructure'}})},node).mode, 'infrastructure');
for (const hostname of ['attacker.example/path','localhost','127.0.0.1','10.0.0.5','localhost.example..com','bad-.example.com','EXAMPLE.COM','host.local','a'.repeat(64)+'.example.com']) {
 assert.throws(()=>controllerSshAccess({SSH_ACCESS_HOSTS_JSON:JSON.stringify({[node]:{hostname,mode:'browser'}})},node), /ssh_access_config_invalid/, hostname);
}
assert.throws(()=>controllerSshAccess({SSH_ACCESS_HOSTS_JSON:'{'},node),/ssh_access_config_invalid/);
console.log('Controller-owned SSH access mapping: OK');

// Invalid SSH configuration must disable SSH without breaking unrelated node details.
const { nodeSshStateResponse } = await import('../src/index.js');
const env = {
 SSH_ACCESS_HOSTS_JSON:'{',
 DB: {
  batch: async()=>[],
  prepare: sql=>({bind:()=>({first:async()=>({node_id:node,ssh_server_running:1,local_port_open:1,cloudflared_running:1,tunnel_configured:1,checked_at:new Date().toISOString(),updated_at:new Date().toISOString()})})})
 }
};
const snapshot = await nodeSshStateResponse(env,node);
assert.equal(snapshot.ready,false);
assert.equal(snapshot.access_hostname,null);
assert.equal(snapshot.access_config_error,'ssh_access_config_invalid');

const tunnelRow = {node_id:node,ssh_server_running:1,local_port_open:1,cloudflared_running:1,tunnel_configured:1,access_hostname:'unrelated.example.com',checked_at:new Date().toISOString(),updated_at:new Date().toISOString()};
const tunnelEnv = {
 SSH_ACCESS_HOSTS_JSON:JSON.stringify({[node]:{hostname:'terminal.example.com',mode:'browser'}}),
 DB:{prepare:()=>({bind:()=>({first:async()=>tunnelRow})})}
};
assert.equal((await nodeSshStateResponse(tunnelEnv,node)).ready,false);
tunnelRow.access_hostname='terminal.example.com';
assert.equal((await nodeSshStateResponse(tunnelEnv,node)).ready,true);

// A signed node may have an offset clock; Controller receipt time governs freshness.
tunnelRow.checked_at=new Date(Date.now()-120000).toISOString();
assert.equal((await nodeSshStateResponse(tunnelEnv,node)).ready,true);
