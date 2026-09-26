// Analytics are read from Cloudflare, never counted by scanning operational D1 tables.
const TTL_MS = 300000;
let cached = null;
let inFlight = null;
const QUERY = `query D1Overview($account: string!, $database: string!, $date: Date!) {
  viewer { accounts(filter: {accountTag: $account}) {
    account: d1AnalyticsAdaptiveGroups(limit: 1, filter: {date: $date}) { sum { rowsRead rowsWritten } }
    database: d1AnalyticsAdaptiveGroups(limit: 1, filter: {date: $date, databaseId: $database}) { sum { rowsRead rowsWritten } }
  } }
}`;

function metric(used, limit) {
  return {used, limit, percent: used === null || limit === null ? null : Math.round(used / limit * 10000) / 100,
    remaining: used === null || limit === null ? null : Math.max(0, limit - used)};
}
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
function totals(rows) {
  if (!Array.isArray(rows)) throw Error('invalid_analytics_response');
  if (!rows.length) return {rowsRead: 0, rowsWritten: 0};
  const sum = rows[0]?.sum;
  if (number(sum?.rowsRead) === null || number(sum?.rowsWritten) === null) throw Error('invalid_analytics_response');
  return sum;
}
async function cfJson(url, token, options = {}) {
  const response = await fetch(url, {...options, redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: {'authorization': 'Bearer ' + token, 'content-type': 'application/json'}});
  if (!response.ok) throw Error('cloudflare_http_' + response.status);
  const body = await response.json();
  if (body.success === false || body.errors?.length) throw Error('cloudflare_api_error');
  return body;
}
export async function d1UsageOverview(env, now = new Date()) {
  const account = String(env.D1_ANALYTICS_ACCOUNT_ID || '').trim();
  const database = String(env.D1_ANALYTICS_DATABASE_ID || '').trim();
  const token = String(env.D1_ANALYTICS_TOKEN || '').trim();
  const plan = ['free', 'paid'].includes(env.D1_USAGE_PLAN) ? env.D1_USAGE_PLAN : 'unknown';
  const date = now.toISOString().slice(0, 10);
  const base = {ok: true, status: 'unconfigured', plan, date_utc: date,
    reset_at: new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString(),
    source: 'cloudflare_analytics', scope: 'account_daily_usage_and_selected_database',
    note: 'Analytics may be delayed or sampled; account quotas include every D1 database.',
    account: {rows_read: metric(null, plan === 'free' ? 5000000 : null), rows_written: metric(null, plan === 'free' ? 100000 : null)},
    database: {rows_read: null, rows_written: null, storage: metric(null, plan === 'free' ? 500 * 1024 ** 2 : plan === 'paid' ? 10 * 1024 ** 3 : null)}};
  if (!token || !/^[a-f0-9]{32}$/i.test(account) || !/^[a-f0-9-]{36}$/i.test(database)) return base;
  // Cache identity includes the secret to invalidate it on rotation; it is never returned.
  const key = [account, database, token, plan, date].join(':');
  if (cached?.key === key && cached.expires > now.getTime()) return cached.value;
  if (inFlight?.key === key) return inFlight.promise;
  const promise = (async () => {
    let result;
    try {
      const [analytics, detail] = await Promise.all([
        cfJson('https://api.cloudflare.com/client/v4/graphql', token, {method: 'POST', body: JSON.stringify({query: QUERY, variables: {account, database, date}})}),
        cfJson(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}`, token)
      ]);
      const row = analytics.data?.viewer?.accounts?.[0];
      if (!row) throw Error('analytics_account_unavailable');
      const all = totals(row.account), db = totals(row.database);
      const size = number(detail.result?.file_size);
      result = {...base, status: size === null ? 'partial' : 'ready', updated_at: now.toISOString(),
        account: {rows_read: metric(all.rowsRead, base.account.rows_read.limit), rows_written: metric(all.rowsWritten, base.account.rows_written.limit)},
        database: {rows_read: db.rowsRead, rows_written: db.rowsWritten, storage: metric(size, base.database.storage.limit)}};
    } catch (error) {
      result = {...base, status: 'unavailable', error: /^cloudflare_http_\d+$/.test(error.message) ? error.message : 'analytics_unavailable'};
    }
    cached = {key, expires: now.getTime() + (result.status === 'unavailable' ? 30000 : TTL_MS), value: result};
    return result;
  })();
  const current = {key, promise};
  inFlight = current;
  try {return await promise;} finally {if (inFlight === current) inFlight = null;}
}
