import {
  TELEMETRY_LIMITS,
  TelemetryError,
  authenticateArchitect,
  json,
  optionalString,
  safeJson
} from "./common.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { ALLOWED_EVENT_TYPES, validLogLevel } from "./normalize.js";
import { pruneExpiredTelemetry } from "./schema.js";

export async function architectListLogs(request, env, url) {
  await authenticateArchitect(request, env);
  await pruneExpiredTelemetry(env);

  const rawLimit = url.searchParams.get("limit") || "50";
  if (!/^\d{1,3}$/.test(rawLimit)) {
    throw new TelemetryError(400, "invalid_limit");
  }
  const limit = Number(rawLimit);
  if (limit < 1 || limit > TELEMETRY_LIMITS.page_size) {
    throw new TelemetryError(400, "invalid_limit");
  }

  const nodeId = optionalString(url.searchParams.get("node_id"), "node_id", 128);
  const level = optionalString(url.searchParams.get("level"), "level", 16)?.toLowerCase() || null;
  const eventType = optionalString(url.searchParams.get("event_type"), "event_type", 80)?.toLowerCase() || null;
  if (!validLogLevel(level)) throw new TelemetryError(400, "invalid_level");
  if (eventType && !ALLOWED_EVENT_TYPES.has(eventType)) {
    throw new TelemetryError(400, "event_type_not_allowed");
  }

  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const cursorCreated = cursor?.[0] || null;
  const cursorEventId = cursor?.[1] || null;
  const query = await env.DB.prepare(`
    SELECT event_id, node_id, level, event_type, message, details_json,
           created_at, received_at
    FROM node_logs
    WHERE (? IS NULL OR node_id = ?)
      AND (? IS NULL OR level = ?)
      AND (? IS NULL OR event_type = ?)
      AND (
        ? IS NULL OR created_at < ? OR (created_at = ? AND event_id < ?)
      )
    ORDER BY created_at DESC, event_id DESC
    LIMIT ?
  `).bind(
    nodeId, nodeId,
    level, level,
    eventType, eventType,
    cursorCreated, cursorCreated, cursorCreated, cursorEventId,
    limit + 1
  ).all();

  const rows = query.results || [];
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const logs = selected.map((row) => ({
    ...row,
    details: safeJson(row.details_json, {}),
    details_json: undefined
  }));
  return json({
    ok: true,
    logs,
    next_cursor: hasMore && selected.length
      ? encodeCursor(selected[selected.length - 1])
      : null
  });
}

export async function architectLogStats(request, env) {
  await authenticateArchitect(request, env);
  await pruneExpiredTelemetry(env);
  const totals = await env.DB.prepare(`
    SELECT COUNT(*) AS event_count,
      COUNT(DISTINCT node_id) AS node_count,
      MIN(received_at) AS oldest_received_at,
      MAX(received_at) AS newest_received_at
    FROM node_logs
  `).first();
  const byNode = await env.DB.prepare(`
    SELECT node_id, COUNT(*) AS event_count, MAX(created_at) AS newest_created_at
    FROM node_logs
    GROUP BY node_id
    ORDER BY event_count DESC, node_id ASC
    LIMIT 100
  `).all();
  return json({
    ok: true,
    stats: {
      event_count: totals?.event_count || 0,
      node_count: totals?.node_count || 0,
      oldest_received_at: totals?.oldest_received_at || null,
      newest_received_at: totals?.newest_received_at || null,
      retention_days: TELEMETRY_LIMITS.retention_days,
      per_node_event_cap: TELEMETRY_LIMITS.per_node_events,
      nodes: byNode.results || []
    }
  });
}
