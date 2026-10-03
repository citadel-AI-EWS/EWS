import fs from "node:fs";
import {collectWriteDiagnostics} from './d1_write_diagnostics.mjs';

const config = fs.readFileSync("wrangler.jsonc", "utf8");
const account = config.match(/"D1_ANALYTICS_ACCOUNT_ID"\s*:\s*"([a-f0-9]+)"/i)?.[1];
const database = config.match(/"D1_ANALYTICS_DATABASE_ID"\s*:\s*"([a-f0-9-]+)"/i)?.[1];
if (!account || !database) throw Error("d1_configuration_missing");
const date = new Date().toISOString().slice(0, 10);
const report = { date_utc: date, source: "cloudflare_api", reads: null, writes: null,
  database_reads: null, database_writes: null,
  storage_bytes: null, read_limit: 5_000_000, write_limit: 100_000,
  storage_limit: 500 * 1024 ** 2, errors: [] };
const query = `query D1Capacity($account: string!, $database: string!, $date: Date!) {
  viewer { accounts(filter: {accountTag: $account}) {
    usage: d1AnalyticsAdaptiveGroups(limit: 1, filter: {date: $date}) {
      sum { rowsRead rowsWritten }
    }
    database_usage: d1AnalyticsAdaptiveGroups(limit: 1, filter: {date: $date, databaseId: $database}) {
      sum { rowsRead rowsWritten }
    }
  } }
}`;
const storageQuery = `query D1Storage($account: string!, $database: string!, $date: Date!) {
  viewer { accounts(filter: {accountTag: $account}) {
    storage: d1StorageAdaptiveGroups(limit: 1, filter: {date: $date, databaseId: $database}) {
      max { databaseSizeBytes }
    }
  } }
}`;
async function cfJson(path, token, options = {}) {
  if (!token) throw Error("token_unconfigured");
  let response;
  try {
    response = await fetch("https://api.cloudflare.com/client/v4/" + path, {
      ...options, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      redirect: "error", signal: AbortSignal.timeout(15000)
    });
  } catch { throw Error("cloudflare_fetch_failed"); }
  if (!response.ok) throw Error("cloudflare_http_" + response.status);
  const value = await response.json().catch(() => { throw Error("invalid_cloudflare_json"); });
  if (value.success === false || value.errors?.length) throw Error("cloudflare_api_error");
  return value;
}
const [usage, storage] = await Promise.allSettled([
  cfJson("graphql", process.env.D1_ANALYTICS_TOKEN || process.env.CLOUDFLARE_API_TOKEN, {
    method: "POST", body: JSON.stringify({ query, variables: { account, database, date } })
  }),
  cfJson("graphql", process.env.D1_ANALYTICS_TOKEN || process.env.CLOUDFLARE_API_TOKEN, {
    method: "POST", body: JSON.stringify({ query: storageQuery, variables: { account, database, date } })
  })
]);
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
if (usage.status === "fulfilled") {
  const rows = usage.value.data?.viewer?.accounts?.[0]?.usage;
  const sum = Array.isArray(rows) && !rows.length ? { rowsRead: 0, rowsWritten: 0 } : rows?.[0]?.sum;
  report.reads = number(sum?.rowsRead);
  report.writes = number(sum?.rowsWritten);
  const dbRows = usage.value.data?.viewer?.accounts?.[0]?.database_usage;
  const dbSum = Array.isArray(dbRows) && !dbRows.length ? { rowsRead: 0, rowsWritten: 0 } : dbRows?.[0]?.sum;
  report.database_reads = number(dbSum?.rowsRead);
  report.database_writes = number(dbSum?.rowsWritten);
  if (report.reads === null || report.writes === null) report.errors.push("invalid_analytics_response");
} else report.errors.push("analytics:" + usage.reason.message);
if (storage.status === "fulfilled") {
  report.storage_bytes = number(storage.value.data?.viewer?.accounts?.[0]?.storage?.[0]?.max?.databaseSizeBytes);
  report.storage_measurement = "maximum_observed_today";
  if (report.storage_bytes === null) report.errors.push("storage_size_unavailable");
} else report.errors.push("storage:" + storage.reason.message);

try {
  const worker = config.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
  const value = await cfJson(`accounts/${account}/workers/scripts/${worker}/schedules`, process.env.CLOUDFLARE_API_TOKEN);
  const schedules = Array.isArray(value.result) ? value.result : value.result?.schedules;
  report.guardian_cron_configured = Array.isArray(schedules)
    ? schedules.some(s => s.cron === "*/5 * * * *") : null;
} catch { report.guardian_cron_configured = null; }

try {
  const response = await fetch("https://citadel-ai.init1.workers.dev/api/v1/status/d1-retention", {
    signal: AbortSignal.timeout(15000), redirect: "error"
  });
  report.retention = response.ok ? await response.json() : { status: "unavailable", http_status: response.status };
} catch { report.retention = { status: "unavailable" }; }
report.threshold_percent = 80;
report.write_diagnostics = await collectWriteDiagnostics(
  (path, options) => cfJson(path, process.env.D1_ANALYTICS_TOKEN || process.env.CLOUDFLARE_API_TOKEN, options),
  {account, database});
if (report.write_diagnostics.windows.some(window => window.status !== 'ready')) {
  report.errors.push('write_insights_unavailable');
}
report.alerts = [];
if (report.guardian_cron_configured === false) report.alerts.push("guardian_cron_missing");
for (const [name, used, limit] of [
  ['reads', report.reads, report.read_limit], ['writes', report.writes, report.write_limit],
  ['storage', report.storage_bytes, report.storage_limit]
]) {
  if (used !== null && used / limit >= 0.8) report.alerts.push(name + "_at_or_above_80_percent");
}
if (report.retention?.batch_limit_reached) report.alerts.push("retention_backlog");
const last = report.retention?.last_run_at;
if (!last || !Number.isFinite(Date.parse(last.replace(' ', 'T') + (last.endsWith('Z') ? '' : 'Z'))) ||
    Date.now() - Date.parse(last.replace(' ', 'T') + (last.endsWith('Z') ? '' : 'Z')) > 26 * 3600_000) {
  report.alerts.push("retention_not_verified_in_26_hours");
}
report.status = report.errors.length ? "incomplete" : report.alerts.length ? "warning" : "ready";
const summary = "```json\n" + JSON.stringify(report, null, 2) + "\n```";
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
console.log(JSON.stringify(report));

// Publish only numeric capacity data and safe reason codes for the daily task.
// Credentials stay in the runner environment; neither headers nor raw API errors
// are written to the check, logs or an artifact.
if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY && process.env.GITHUB_SHA) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/check-runs`, {
    method: "POST", headers: { authorization: "Bearer " + process.env.GITHUB_TOKEN,
      "content-type": "application/json", "accept": "application/vnd.github+json" },
    body: JSON.stringify({ name: "D1 capacity diagnostics", head_sha: process.env.CITADEL_CHECK_SHA || process.env.GITHUB_SHA,
      status: "completed", conclusion: report.status === "ready" ? "success" : "neutral",
      output: { title: "D1 capacity: " + report.status, summary } }),
    redirect: "error", signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw Error("capacity_check_publish_http_" + response.status);
}
