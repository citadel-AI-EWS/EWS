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
