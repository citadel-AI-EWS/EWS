import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {main} from '../scripts/provision_cloudflare_ssh.mjs';

const account = 'a'.repeat(32);
const host = 'ssh.example.com';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ews-ssh-provision-'));
Object.assign(process.env, {
  CLOUDFLARE_ACCOUNT_ID: account,
  FULL_CLOUDFLARE_CONTROL: 'synthetic-api-token',
  CITADEL_SSH_HOSTNAME: host,
  CITADEL_SSH_ALLOWED_EMAIL: 'operator@example.com',
  CITADEL_SSH_TUNNEL_NAME: 'citadel-ssh-operator',
  CITADEL_SSH_SESSION_DURATION: '1h',
  CITADEL_CF_OUTPUT: path.join(directory, 'plan.json')
});
const originalFetch = globalThis.fetch;
const originalWrite = process.stdout.write;
const policy = {id: 'policy', name: `CITADEL SSH allow ${host}`, decision: 'allow',
  include: [{email: {email: 'operator@example.com'}}],
  require: [{auth_method: {auth_method: 'mfa'}}], exclude: [{email: {email: 'blocked@example.com'}}]};
let output = '';
let calls = [];
let options = {};
process.stdout.write = text => {output += text; return true;};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  assert.equal(url.origin, 'https://api.cloudflare.com');
  assert.equal(init.headers.authorization, 'Bearer synthetic-api-token');
  assert.ok(init.signal, 'API calls must have a bounded timeout');
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({url: url.pathname, method, body});
  assert.ok(!url.pathname.endsWith('/token'), 'never retrieve a Tunnel token');
  let result;
  if (url.pathname === '/client/v4/zones') result = [{id: 'zone', name: 'example.com'}];
  else if (url.pathname.endsWith('/cfd_tunnel')) result = [{id: 'tunnel', name: 'citadel-ssh-operator', config_src: options.configSource || 'cloudflare'}];
  else if (url.pathname.endsWith('/configurations')) result = {config: body?.config || {
    originRequest: {connectTimeout: 15}, 'warp-routing': {enabled: true},
    ingress: [{hostname: 'private.example.com', service: 'http://SYNTHETIC_PRIVATE_CONFIG@localhost:8080'}, {service: 'http_status:404'}]
  }};
  else if (url.pathname.endsWith('/dns_records')) result = [{id: 'dns', type: 'CNAME', content: 'tunnel.cfargotunnel.com', proxied: true}];
  else if (url.pathname.endsWith('/access/apps')) result = [{id: 'app', domain: host, name: 'CITADEL SSH operator', type: 'ssh', session_duration: options.session || '1h'}];
  else if (url.pathname.endsWith('/access/apps/app')) result = {id: 'app', ...body};
  else if (url.pathname.endsWith('/policies')) result = options.duplicatePolicy ? [policy, {...policy, id: 'second'}] : [policy];
  else if (url.pathname.endsWith('/policies/policy')) result = body;
  else if (url.pathname.endsWith('/ca')) result = {id: 'ca', public_key: 'ssh-rsa synthetic-public-key'};
  else throw new Error(`Unexpected Cloudflare endpoint ${url.pathname}`);
  return new Response(JSON.stringify({success: true, result, result_info: {total_pages: 1}}));
};
try {
  process.env.CITADEL_CF_APPLY = 'false';
  await main();
  assert.ok(calls.length > 0, 'dry run must inspect real resources for conflicts');
  assert.ok(calls.every(c => c.method === 'GET'), 'dry run must not mutate resources');
  assert.equal(JSON.parse(output).applied, false);

  process.env.CITADEL_CF_APPLY = 'true';
  output = ''; calls = [];
  await main();
  const config = calls.find(c => c.method === 'PUT' && c.url.endsWith('/configurations')).body.config;
  assert.deepEqual(config.originRequest, {connectTimeout: 15});
  assert.deepEqual(config['warp-routing'], {enabled: true});
  assert.ok(config.ingress.some(r => r.hostname === 'private.example.com'));
  assert.ok(config.ingress.some(r => r.hostname === host && r.service === 'ssh://localhost:22'));
  const updatedPolicy = calls.find(c => c.method === 'PUT' && c.url.endsWith('/policies/policy')).body;
  assert.deepEqual(updatedPolicy.include, [{email: {email: 'operator@example.com'}}]);
  assert.deepEqual(updatedPolicy.require, policy.require, 'retain MFA requirements');
  assert.deepEqual(updatedPolicy.exclude, policy.exclude, 'retain exclusions');
  assert.ok(!output.includes('SYNTHETIC_PRIVATE_CONFIG'), 'do not print unrelated private ingress configuration');
  assert.ok(!output.includes('synthetic-api-token'));

  for (const [setting, expected] of [
    [{duplicatePolicy: true}, /multiple_policies/],
    [{configSource: 'local'}, /not_remotely_managed/]
  ]) {
    for (const apply of ['true', 'false']) {
      process.env.CITADEL_CF_APPLY = apply;
      options = setting; calls = []; output = '';
      await assert.rejects(main(), expected);
      assert.ok(!calls.some(c => c.url.endsWith('/policies/policy') && c.method === 'PUT'));
      if (setting.configSource || apply === 'false') assert.ok(calls.every(c => c.method === 'GET'));
    }
  }
  options = {session: '24h'}; calls = []; output = '';
  process.env.CITADEL_CF_APPLY = 'false';
  await main();
  assert.equal(JSON.parse(output).access_app.update_required, true);
  assert.ok(calls.every(c => c.method === 'GET'));
  calls = []; output = ''; process.env.CITADEL_CF_APPLY = 'true';
  await main();
  const appUpdate = calls.find(c => c.url.endsWith('/access/apps/app') && c.method === 'PUT');
  assert.equal(appUpdate.body.session_duration, '1h');
  assert.equal(JSON.parse(output).access_app.session_duration, '1h');
} finally {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalWrite;
  fs.rmSync(directory, {recursive: true, force: true});
}
console.log('SSH provisioning: dry run, preserved tunnel/MFA configuration, private-output boundary and conflict rejection PASS');
