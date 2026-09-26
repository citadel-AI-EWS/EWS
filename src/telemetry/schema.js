import { TELEMETRY_LIMITS, TelemetryError } from "./common.js";

let telemetrySchemaPromise;

export async function ensureTelemetryStorage(env) {
  if (!telemetrySchemaPromise) {
    telemetrySchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS node_logs (
          event_id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL,
          level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
          event_type TEXT NOT NULL,
          message TEXT NOT NULL,
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_logs_node_created
        ON node_logs(node_id, created_at DESC, event_id DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_logs_received
        ON node_logs(received_at DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_logs_level_created
        ON node_logs(level, created_at DESC)
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS node_log_rate_limits (
          node_id TEXT PRIMARY KEY,
          window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
        )
      `)
    ]).catch((error) => {
      telemetrySchemaPromise = undefined;
      throw error;
    });
  }
  await telemetrySchemaPromise;
}

export async function enforceTelemetryRateLimit(env, nodeId) {
  await ensureTelemetryStorage(env);
  const windowSeconds = TELEMETRY_LIMITS.rate_window_seconds;
  await env.DB.prepare(`
    INSERT INTO node_log_rate_limits (node_id, window_started_at, request_count)
    VALUES (?, CURRENT_TIMESTAMP, 1)
    ON CONFLICT(node_id) DO UPDATE SET
      request_count = CASE
        WHEN datetime(window_started_at) <= datetime('now', '-${windowSeconds} seconds') THEN 1
        ELSE request_count + 1
      END,
      window_started_at = CASE
        WHEN datetime(window_started_at) <= datetime('now', '-${windowSeconds} seconds') THEN CURRENT_TIMESTAMP
        ELSE window_started_at
      END
  `).bind(nodeId).run();

  const state = await env.DB.prepare(`
    SELECT request_count, window_started_at
    FROM node_log_rate_limits
    WHERE node_id = ?
  `).bind(nodeId).first();
  if ((state?.request_count || 0) > TELEMETRY_LIMITS.requests_per_window) {
    throw new TelemetryError(429, "telemetry_rate_limited", {
      "retry-after": String(windowSeconds)
    });
  }
}

export async function pruneExpiredTelemetry(env) {
  await ensureTelemetryStorage(env);
  await env.DB.prepare(`
    DELETE FROM node_logs
    WHERE received_at < datetime('now', '-7 days')
  `).run();
}
