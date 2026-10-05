// Read-only production diagnostics for command persistence. Never print tokens,
// SQL errors, row contents, or private node data in Actions logs.
import fs from "node:fs";

const config = fs.readFileSync("wrangler.jsonc", "utf8");
const account = config.match(/"D1_ANALYTICS_ACCOUNT_ID"\s*:\s*"([a-f0-9]+)"/i)?.[1];
const database = config.match(/"D1_ANALYTICS_DATABASE_ID"\s*:\s*"([a-f0-9-]+)"/i)?.[1];
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !database || !token) throw Error("command_schema_diagnostic_not_configured");

const queries = {
  commands: "PRAGMA table_info(commands)",
  audit_events: "PRAGMA table_info(audit_events)",
  duplicate_active: "SELECT COUNT(*) AS total FROM (SELECT node_id FROM commands WHERE status IN ('pending','accepted') GROUP BY node_id HAVING COUNT(*) > 1)"
};
const report = {};
for (const [name, sql] of Object.entries(queries)) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(15000)
    }
  );
  if (!response.ok) {
    report[name] = { status: "unavailable", http_status: response.status };
    continue;
  }
  const data = await response.json();
  if (data.success !== true) {
    report[name] = { status: "unavailable", reason: "query_failed" };
    continue;
  }
  const rows = data.result?.[0]?.results || [];
  report[name] = name === "duplicate_active"
    ? { status: "ready", count: Number(rows[0]?.total || 0) }
    : { status: "ready", columns: rows.map(row => String(row.name || "")) };
}
console.log(JSON.stringify(report));
