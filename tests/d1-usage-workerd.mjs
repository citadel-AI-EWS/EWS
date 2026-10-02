import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

// Exercise fetch options in workerd, where Node-only mocks miss unsupported values.
const bundle = await build({stdin: {contents: `
  import {d1UsageStatus} from './src/d1-usage.js';
  export default {async fetch(request, env) {
    return Response.json(await d1UsageStatus({...env,
      D1_ANALYTICS_TOKEN: 'synthetic-token-' + new URL(request.url).pathname}));
  }};`, resolveDir: process.cwd()}, bundle: true, format: 'esm', write: false});
let mode = 'ready', requests = 0;
const mf = new Miniflare(convertV4MiniflareOptions({modules: true,
  script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-05',
  bindings: {D1_ANALYTICS_ACCOUNT_ID: 'a'.repeat(32),
    D1_ANALYTICS_DATABASE_ID: '8e7855f0-905d-4ca4-96e7-4df015ada1c7', D1_USAGE_PLAN: 'free'},
  outboundService: async request => {
    requests++;
    assert.equal(request.url, 'https://api.cloudflare.com/client/v4/graphql');
    assert.equal(request.method, 'POST');
    assert.match(request.headers.get('authorization'), /^Bearer synthetic-token-/);
    assert.equal((await request.json()).variables.account, 'a'.repeat(32));
    if (mode === 'redirect') return new Response(null, {status: 302,
      headers: {location: 'https://untrusted.example/collect'}});
    if (mode === 'denied') return new Response(null, {status: 403});
    return Response.json({data: {viewer: {accounts: [{
      account: [{sum: {rowsRead: 4500000, rowsWritten: 50000}}],
      database: [{sum: {rowsRead: 5000, rowsWritten: 200}}]
    }]}}});
  }}));
try {
  const ready = await (await mf.dispatchFetch('https://hub.test/ready')).json();
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal(ready.usage_percent, 90);
  assert.equal(requests, 1);
  mode = 'redirect';
  const redirect = await (await mf.dispatchFetch('https://hub.test/redirect')).json();
  assert.equal(redirect.availability_error, 'cloudflare_http_302');
  assert.equal(requests, 2, 'redirect must not forward the analytics bearer token');
  mode = 'denied';
  const denied = await (await mf.dispatchFetch('https://hub.test/denied')).json();
  assert.equal(denied.availability_error, 'cloudflare_http_403');
  assert.equal(requests, 3);
  assert.ok(!JSON.stringify([ready, redirect, denied]).includes('synthetic-token'));
  console.log('D1 analytics workerd: real fetch options, quota percent, no redirect following and safe HTTP errors PASS');
} finally {
  await mf.dispose();
}
