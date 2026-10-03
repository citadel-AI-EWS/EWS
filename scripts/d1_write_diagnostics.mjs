import {createHash} from 'node:crypto';

// Same dataset/filter as the pinned Wrangler d1 insights command. Analytics only:
// this does not query or mutate the operational database, or add per-request logs.
const QUERY = `query D1WriteSources($account: string!, $database: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    writes: d1QueriesAdaptiveGroups(limit: 30,
      filter: {databaseId: $database, datetimeHour_geq: $start, datetimeHour_leq: $end},
      orderBy: [sum_rowsWritten_DESC]) {
      count
      sum { rowsRead rowsWritten }
      dimensions { query }
    }
  } }
}`;
const TABLES = new Set(['nodes', 'node_request_nonces', 'node_ssh_state',
  'node_network_state', 'node_hardware_state', 'node_presence', 'node_ai_state',
  'node_ai_runtime_state', 'node_logs', 'node_rate_windows', 'd1_guardian_state',
  'd1_guardian_actions', 'commands', 'assignments', 'results', 'audit_events',
  'architect_projects', 'project_work_items', 'architect_auth_rate_limits']);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function summarizeWriteSources(rows) {
  if (!Array.isArray(rows)) throw Error('invalid_write_insights_response');
  const queries = rows.map(row => {
    if (typeof row?.dimensions?.query !== 'string' || !number(row.count) ||
        !number(row?.sum?.rowsRead) || !number(row?.sum?.rowsWritten)) {
      throw Error('invalid_write_insights_response');
    }
    const sql = row.dimensions.query;
    const match = sql.match(/^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`\[]?([a-z_][a-z_0-9]*)/i);
    const table = match?.[1]?.toLowerCase();
    // No raw SQL, literals, bind values, node IDs, network addresses or secrets
    // enter the public Actions log/check. Unknown table names are never echoed.
    return {source: TABLES.has(table) ? table : 'other',
      query_id: createHash('sha256').update(sql).digest('hex').slice(0, 16),
      executions: row.count, rows_read: row.sum.rowsRead, rows_written: row.sum.rowsWritten};
  }).filter(row => row.rows_written > 0);
  return queries.sort((a, b) => b.rows_written - a.rows_written);
}

export async function collectWriteDiagnostics(cfJson, {account, database, now = new Date()}) {
  const end = now.toISOString();
  const midnight = end.slice(0, 10) + 'T00:00:00.000Z';
  const hourEnd = new Date(Math.floor(+now / 3600000) * 3600000);
  const windows = [
    {name: 'utc_day_so_far', start: midnight, end},
    {name: 'previous_complete_utc_hour', start: new Date(+hourEnd - 3600000).toISOString(),
      end: new Date(+hourEnd - 1).toISOString()}
  ];
  const results = [];
  for (const window of windows) {
    try {
      const value = await cfJson('graphql', {
        method: 'POST', body: JSON.stringify({query: QUERY,
          variables: {account, database, start: window.start, end: window.end}})
      });
      const queries = summarizeWriteSources(value.data?.viewer?.accounts?.[0]?.writes);
      results.push({...window, status: 'ready', queries,
        returned_rows_written: queries.reduce((sum, row) => sum + row.rows_written, 0)});
    } catch {
      results.push({...window, status: 'unavailable', error: 'write_insights_unavailable'});
    }
  }
  return {source: 'cloudflare_query_insights', query_limit: 30,
    note: 'Adaptive, potentially sampled/delayed top-query metrics; not a complete audit or exact reconciliation with daily billing totals.',
    windows: results};
}
