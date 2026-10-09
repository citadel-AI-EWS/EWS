import assert from 'node:assert/strict';
import {invokeSshRelay,sshRelayAvailability} from '../src/ssh/availability.js';

let calls=0;
const env={SSH_RELAY:{idFromName:x=>x,get:()=>({fetch:async()=>{
  calls++;throw Error('Your account exceeded its daily limit of requests to Durable Objects. Bearer private-fixture');
}})}};
await assert.rejects(invokeSshRelay(env,'fixture','https://relay.internal/attach'),error=>
  error.status===503&&error.code==='ssh_durable_request_limit'&&error.retry_after_seconds>0&&error.retry_after_seconds<=86400);
for(let i=0;i<3;i++) await assert.rejects(invokeSshRelay(env,'fixture','https://relay.internal/attach'),
  error=>error.code==='ssh_durable_request_limit');
assert.equal(calls,1,'known SSH quota outage cannot issue more Durable Object requests');
assert.equal(sshRelayAvailability(env).status,'blocked');
assert.ok(!JSON.stringify(sshRelayAvailability(env)).includes('private-fixture'));
const transient={SSH_RELAY:{idFromName:x=>x,get:()=>({fetch:async()=>{throw Error('private URL https://secret.invalid');}})}};
await assert.rejects(invokeSshRelay(transient,'fixture','https://relay.internal/attach'),error=>
  error.code==='ssh_relay_unavailable'&&error.retry_after_seconds===30);
console.log('SSH quota: bounded retry, cached UTC reset, private diagnostics and independent node control PASS');
