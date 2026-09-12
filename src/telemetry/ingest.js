import {
  TELEMETRY_LIMITS,
  TelemetryError,
  authenticateNode,
  json,
  parseJsonObject,
  readBodyText
} from "./common.js";
import { normalizeTelemetryEvent } from "./normalize.js";
import { ensureTelemetryStorage } from "./schema.js";

export async function ingestNodeLogs(request, env, nodeId, url) {
  const bodyText = await readBodyText(request, TELEMETRY_LIMITS.request_bytes);
  await authenticateNode(request, env, nodeId, url, bodyText);
  const body = parseJsonObject(bodyText);
  if (!Array.isArray(body.events) || body.events.length < 1) {
    throw new TelemetryError(400, "events_required");
  }
  if (body.events.length > TELEMETRY_LIMITS.batch_events) {
    throw new TelemetryError(413, "too_many_events");
  }
  const events = body.events.map(normalizeTelemetryEvent);
  await ensureTelemetryStorage(env);

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
  const results = await env.DB.batch(insertStatements);
  const accepted = results.reduce(
    (sum, result) => sum + (result?.meta?.changes || 0),
    0
  );

  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM node_logs
      WHERE datetime(received_at) < datetime('now', '-7 days')
    `),
    env.DB.prepare(`
      DELETE FROM node_logs
      WHERE node_id = ?
        AND event_id NOT IN (
          SELECT event_id FROM node_logs
          WHERE node_id = ?
          ORDER BY created_at DESC, event_id DESC
          LIMIT 5000
        )
    `).bind(nodeId, nodeId),
    env.DB.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, action, target_type, target_id, details_json
      ) VALUES ('node', ?, 'telemetry.ingested', 'node', ?, ?)
    `).bind(
      nodeId,
      nodeId,
      JSON.stringify({ received: events.length, accepted })
    )
  ]);

  return json({
    ok: true,
    received: events.length,
    accepted,
    duplicates: events.length - accepted,
    retention_days: TELEMETRY_LIMITS.retention_days,
    per_node_event_cap: TELEMETRY_LIMITS.per_node_events
  }, accepted ? 201 : 200);
}
