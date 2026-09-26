import { keepOperationalEvent } from "./retention.js";
import {
  TELEMETRY_LIMITS,
  TelemetryError,
  authenticateNode,
  json,
  parseJsonObject,
  readBody
} from "./common.js";
import { normalizeTelemetryEvent } from "./normalize.js";
import {
  enforceTelemetryRateLimit,
  ensureTelemetryStorage
} from "./schema.js";

export async function ingestNodeLogs(request, env, nodeId, url) {
  const { bytes: bodyBytes, text: bodyText } = await readBody(
    request,
    TELEMETRY_LIMITS.request_bytes
  );
  await authenticateNode(request, env, nodeId, url, bodyBytes);
  await ensureTelemetryStorage(env);
  await enforceTelemetryRateLimit(env, nodeId);

  const body = parseJsonObject(bodyText);
  if (!Array.isArray(body.events) || body.events.length < 1) {
    throw new TelemetryError(400, "events_required");
  }
  if (body.events.length > TELEMETRY_LIMITS.batch_events) {
    throw new TelemetryError(413, "too_many_events");
  }
  const normalized = body.events.map(normalizeTelemetryEvent);
  const events = normalized.filter(keepOperationalEvent);

  const insertStatements = events.map((event) => env.DB.prepare(`
    INSERT OR IGNORE INTO node_logs (
      event_id, node_id, level, event_type, message, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.event_id,
    nodeId,
    event.level,
    event.event_type,
    event.message,
    event.details_json,
    event.created_at
  ));
  const results = insertStatements.length ? await env.DB.batch(insertStatements) : [];
  const accepted = results.reduce(
    (sum, result) => sum + (result?.meta?.changes || 0),
    0
  );

  // Telemetry batches are intentionally not mirrored into audit_events: doing so
  // would make the supposedly bounded observability path grow D1 indefinitely.
  // The per-node cap stays strict. Age-based retention is opportunistic and uses
  // the received_at index without wrapping the indexed column in datetime().
  const retention = [
    env.DB.prepare(`
      DELETE FROM node_logs
      WHERE node_id = ?
        AND event_id NOT IN (
          SELECT event_id FROM node_logs
          WHERE node_id = ?
          ORDER BY created_at DESC, event_id DESC
          LIMIT 5000
        )
    `).bind(nodeId, nodeId)
  ];
  const retentionKey = events[0]?.event_id || "";
  if (retentionKey.endsWith("0")) {
    retention.push(env.DB.prepare(`
      DELETE FROM node_logs
      WHERE received_at < datetime('now', '-7 days')
    `));
  }
  await env.DB.batch(retention);

  return json({
    ok: true,
    received: normalized.length,
    discarded: normalized.length - events.length,
    accepted,
    duplicates: events.length - accepted,
    retention_days: TELEMETRY_LIMITS.retention_days,
    per_node_event_cap: TELEMETRY_LIMITS.per_node_events,
    rate_limit: {
      requests: TELEMETRY_LIMITS.requests_per_window,
      window_seconds: TELEMETRY_LIMITS.rate_window_seconds
    }
  }, accepted ? 201 : 200);
}
