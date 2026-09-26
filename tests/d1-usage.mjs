import assert from 'node:assert/strict';
import {d1UsageOverview} from '../src/d1-usage.js';
const now = new Date('2026-09-26T15:00:00Z');
const env = {D1_ANALYTICS_ACCOUNT_ID: 'a'.repeat(32), D1_ANALYTICS_DATABASE_ID: '8e7855f0-905d-4ca4-96e7-4df015ada1c7', D1_ANALYTICS_TOKEN: 'test-secret', D1_USAGE_PLAN: 'free'};
let requests = 0;
const saved = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  requests++;
  assert.equal(options.headers.authorization, 'Bearer test-secret');
  if (url.endsWith('/graphql')) {
    const q=JSON.parse(options.body);
    assert.equal(q.variables.date,'2026-09-26');
    assert.match(q.query,/account: d1AnalyticsAdaptiveGroups\(limit: 1, filter: \{date: \$date\}\)/);
    return Response.json({data: {viewer: {accounts: [{account: [{sum: {rowsRead: 4500000, rowsWritten: 50000}}], database: [{sum: {rowsRead: 5000, rowsWritten: 200}}]}]}}});
  }
  return Response.json({success:true,result:{file_size:100*1024**2}});
};
try {
  assert.equal((await d1UsageOverview({})).status, 'unconfigured');
  const [a,b] = await Promise.all([d1UsageOverview(env,now),d1UsageOverview(env,now)]);
  assert.equal(requests,2,'concurrent views must share upstream requests');
  assert.deepEqual(a,b);
  assert.equal(a.account.rows_read.percent,90);
  assert.equal(a.account.rows_written.remaining,50000);
  assert.equal(a.database.rows_read,5000,'database usage is separate from account quota');
  assert.equal(a.database.storage.percent,20);
  assert.equal(a.reset_at,'2026-09-27T00:00:00.000Z');
  assert.ok(!JSON.stringify(a).includes('test-secret'));
  await d1UsageOverview(env,new Date(+now+60000)); assert.equal(requests,2);
  const paid=await d1UsageOverview({...env,D1_USAGE_PLAN:'paid'},now);
  assert.equal(paid.account.rows_read.percent,null,'daily usage cannot be compared with paid monthly allowance');
  globalThis.fetch=async()=>Response.json({errors:[{message:'secret-like detail'}]});
  const failed=await d1UsageOverview(env,new Date(+now+360000));
  assert.equal(failed.status,'unavailable'); assert.equal(failed.account.rows_read.used,null);
  assert.ok(!JSON.stringify(failed).includes('secret-like'));
  console.log('D1 overview: account scope, exact arithmetic, missing configuration, caching, paid plan and errors PASS');
} finally {globalThis.fetch=saved;}
