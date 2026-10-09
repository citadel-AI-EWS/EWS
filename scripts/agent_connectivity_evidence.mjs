import {readFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

// The tail may contain request headers, IPs and console details. Keep only
// aggregate counters in memory; never print or write the original events.
export function classifyTailEvent(value) {
  const request = value?.event?.request;
  if (!request?.url) return null;
  let url;
  try {url = new URL(request.url);} catch {return null;}
  if (url.pathname === "/api/health" && url.searchParams.get("connectivity_probe") === "1") return {probe: true};
  const match = url.pathname.match(/^\/api\/v1\/nodes\/[^/]+\/(.+)$/);
  if (!match && url.pathname !== "/api/v1/nodes/enroll") return null;
  const rawRoute = match?.[1].replace(/commands\/[^/]+\/ack$/, "commands/ack");
  const route = !match ? "enroll" :
    ["sync", "heartbeat", "logs", "ai-state", "ssh/relay", "commands", "commands/ack", "assignments", "results"]
      .includes(rawRoute) ? rawRoute : "other_node_route";
  const status = Number(value.event?.response?.status || 0);
  return {route, method: ["GET", "POST", "PUT", "DELETE"].includes(request.method) ? request.method : "other",
    status, outcome: ["ok", "exception", "exceededCpu", "exceededMemory", "canceled"].includes(value.outcome)
      ? value.outcome : "other"};
}

export function jsonObjectStream(onValue) {
  let buffer = "";
  return chunk => {
    buffer += String(chunk);
    if (buffer.length > 1024 * 1024) throw new Error("tail_buffer_limit");
    for (;;) {
      const start = buffer.indexOf("{");
      if (start < 0) {buffer = ""; return;}
      if (start) buffer = buffer.slice(start);
      let depth = 0, quoted = false, escaped = false, end = -1;
      for (let i = 0; i < buffer.length; i++) {
        const char = buffer[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) {end = i + 1; break;}
      }
      if (end < 0) return;
      try {onValue(JSON.parse(buffer.slice(0, end)));} catch {}
      buffer = buffer.slice(end);
    }
  };
}

async function snapshot(config) {
  const account = config.match(/"D1_ANALYTICS_ACCOUNT_ID"\s*:\s*"([^"]+)"/)?.[1];
  const database = config.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1];
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
    method: "POST", headers: {authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN, "content-type": "application/json"},
    signal: AbortSignal.timeout(15000), body: JSON.stringify({sql: `SELECT agent_version, status,
      COUNT(*) AS nodes, SUM(CASE WHEN datetime(last_seen_at) >= datetime('now','-5 minutes') THEN 1 ELSE 0 END) AS fresh,
      MAX(last_seen_at) AS latest_seen_at FROM nodes WHERE status != 'revoked' GROUP BY agent_version, status`})
  });
  const value = await response.json();
  if (!response.ok || !value.success) throw new Error("snapshot_unavailable");
  return value.result?.[0]?.results || [];
}

async function main() {
  const config = await readFile("wrangler.jsonc", "utf8");
  const account = config.match(/"D1_ANALYTICS_ACCOUNT_ID"\s*:\s*"([^"]+)"/)?.[1];
  const worker = config.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
  const report = {checked_at: new Date().toISOString(), window_seconds: 65, positive_control: false,
    agent_requests: 0, routes: {}, snapshot: await snapshot(config)};
  const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "tail", worker,
    "--format=json"], {detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: {...process.env, CLOUDFLARE_ACCOUNT_ID: account, CI: "true", WRANGLER_SEND_METRICS: "false"}});
  const stop = () => {try {process.kill(-child.pid, "SIGTERM");} catch {}};
  let diagnostic = "";
  child.stderr.on("data", chunk => {diagnostic = (diagnostic + String(chunk)).slice(-16384);});
  const parse = jsonObjectStream(value => {
    const result = classifyTailEvent(value);
    if (!result) return;
    if (result.probe) {report.positive_control = true; return;}
    report.agent_requests++;
    const key = `${result.method} ${result.route} ${result.status} ${result.outcome}`;
    report.routes[key] = (report.routes[key] || 0) + 1;
  });
  child.stdout.on("data", chunk => {try {parse(chunk);} catch {report.tail_error = "tail_buffer_limit"; stop();}});
  let exited = false;
  const finished = new Promise(resolve => {
    child.on("error", () => {report.tail_error = "tail_start_failed"; exited = true; resolve();});
    child.on("exit", code => {report.tail_exit_code = code; exited = true; resolve();});
  });
  const started = Date.now();
  for (let attempt = 0; attempt < 5 && !exited; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 8000));
    try {await fetch("https://citadel-ai.init1.workers.dev/api/health?connectivity_probe=1", {
      signal: AbortSignal.timeout(5000), redirect: "error"});} catch {}
    if (report.positive_control) break;
  }
  let windowTimer;
  await Promise.race([finished, new Promise(resolve => {
    windowTimer = setTimeout(resolve, Math.max(0, 65000 - (Date.now() - started)));
  })]);
  clearTimeout(windowTimer);
  stop();
  const killTimer = setTimeout(() => {try {process.kill(-child.pid, "SIGKILL");} catch {}}, 5000);
  await finished;
  clearTimeout(killTimer);
  if (report.tail_exit_code && !report.positive_control) {
    report.tail_error = /authentication|unauthorized|forbidden|permission|\b(?:401|403|10000)\b/i.test(diagnostic)
      ? "tail_authorization_failed" : /unknown argument|unknown option|unexpected argument/i.test(diagnostic)
        ? "tail_arguments_invalid" : /account.*(?:missing|required|specify)/i.test(diagnostic)
          ? "tail_account_required" : "tail_connection_failed";
  }
  diagnostic = "";
  report.elapsed_seconds = Math.round((Date.now() - started) / 1000);
  report.status = report.positive_control ? "observed" : "inconclusive_tail_unverified";
  report.observed_agent_requests = report.positive_control ? report.agent_requests : null;
  console.log(JSON.stringify(report, null, 2));
  if (!report.positive_control) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {console.log(JSON.stringify({status: "blocked", error: "connectivity_evidence_unavailable"})); process.exitCode = 2;});
}
