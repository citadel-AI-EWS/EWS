// Keep the existing replay window (10 minutes) and rate-window lifetime (1 day).
// Daily maintenance only removes expired, replaceable protocol bookkeeping.
const BATCH_LIMIT = 500;
const MAX_BATCHES = 2;
const RULES = [
  ["expired_request_nonces", `DELETE FROM node_request_nonces
    WHERE rowid IN (SELECT rowid FROM node_request_nonces
      WHERE received_at < datetime('now', '-10 minutes')
      ORDER BY received_at LIMIT ?)`],
  ["expired_log_rate_windows", `DELETE FROM node_log_rate_limits
    WHERE rowid IN (SELECT rowid FROM node_log_rate_limits
      WHERE window_started_at < datetime('now', '-1 day')
      ORDER BY window_started_at LIMIT ?)`]
];

export async function pruneExpiredD1Bookkeeping(env) {
  // Keep the durable daily marker and its status read indexed as history grows.
  // This runs in maintenance, never in the public read path.
  try {
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_d1_guardian_actions_action_created
      ON d1_guardian_actions(action, created_at DESC, action_id DESC)`).run();
  } catch (error) {
    if (!/no such table:/i.test(String(error?.message || error))) throw error;
  }
  const result = { ok: true, deleted_rows: 0, rules: [] };
  for (const [name, sql] of RULES) {
    let deleted = 0;
    let bounded = false;
    let missing = false;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      let change;
      try {
        change = await env.DB.prepare(sql).bind(BATCH_LIMIT).run();
      } catch (error) {
        // Optional telemetry/nonce tables may not have been bootstrapped yet.
        if (!/no such table:/i.test(String(error?.message || error))) throw error;
        missing = true;
        break;
      }
      const count = Number(change?.meta?.changes || 0);
      deleted += count;
      if (count < BATCH_LIMIT) break;
      bounded = batch === MAX_BATCHES - 1;
    }
    result.deleted_rows += deleted;
    result.rules.push({ name, deleted_rows: deleted, batch_limit_reached: bounded, table_missing: missing });
  }
  return result;
}

export async function readD1RetentionStatus(env) {
  let row;
  try {
    row = await env.DB.prepare(`SELECT created_at, rows_affected, details_json
      FROM d1_guardian_actions WHERE action = 'daily_bookkeeping_retention'
      ORDER BY created_at DESC, action_id DESC LIMIT 1`).first();
  } catch {
    return { ok: false, status: "unavailable" };
  }
  if (!row) return { ok: true, status: "not_run" };
  let details;
  try { details = JSON.parse(row.details_json); } catch { return { ok: false, status: "unavailable" }; }
  const rules = Array.isArray(details.rules) ? details.rules : [];
  return { ok: true, status: "completed", last_run_at: row.created_at,
    deleted_rows: Number(row.rows_affected || 0),
    batch_limit_reached: rules.some((rule) => rule.batch_limit_reached === true),
    missing_tables: rules.filter((rule) => rule.table_missing === true).length };
}
