import { keepOperationalEvent } from "./retention.js";
import {
  TELEMETRY_LIMITS,
  TelemetryError,
  authenticateNode,
  json,
  parseJsonObject,
  readBody,
  sha256Hex
} from "./common.js";
import { normalizeTelemetryEvent } from "./normalize.js";
import {
  enforceTelemetryRateLimit,
  ensureTelemetryStorage
} from "./schema.js";

const COALESCED_ERROR_TYPES = new Set([
  "cycle_error",
  "operation_heartbeat_failed"
]);
const ERROR_COALESCE_SECONDS = 300;

async function claimNoisyErrorWindow(env, nodeId, event) {
  if (!COALESCED_ERROR_TYPES.has(event.event_type)) return true;
  if (!env.SSH_RELAY || typeof env.SSH_RELAY.idFromName !== "function") return true;
  const fingerprint = await sha256Hex(
    event.event_type + "\n" + event.message + "\n" + event.details_json
  );
  const expires = Math.floor(Date.now() / 1000) + ERROR_COALESCE_SECONDS;
  try {
    const stub = env.SSH_RELAY.get(env.SSH_RELAY.idFromName(nodeId));
    const response = await stub.fetch("https://citadel.internal/telemetry-dedupe", {
      method: "POST",
      headers: {
        "x-citadel-relay-role": "telemetry-dedupe",
        "x-citadel-telemetry-fingerprint": fingerprint,
        "x-citadel-telemetry-expires": String(expires)
      }
    });
    if (response.status === 409) return false;
    if (response.status === 201) return true;
  } catch {
    // Observability must fail open: if the Durable Object is unavailable, keep
    // the event in D1 rather than silently losing a potentially important error.
  }
  return true;
}

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
  const retained = normalized.filter(keepOperationalEvent);
  const events = [];
  let coalesced = 0;
  for (const event of retained) {
    if (await claimNoisyErrorWindow(env, nodeId, event)) events.push(event);
    else coalesced += 1;
  }

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
  // The per-node cap stays strict. A server-controlled scheduled Worker trigger
  // enforces age-based retention independently of node-supplied event IDs.
  // With no new retained rows, a duplicate/routine-only batch cannot exceed the
  // cap. For new rows, seek the boundary once and delete only the overflow range.
  const retention = accepted ? [
    env.DB.prepare(`
      DELETE FROM node_logs
      WHERE node_id = ?
        AND (created_at, event_id) < (
          SELECT created_at, event_id FROM node_logs
          WHERE node_id = ?
          ORDER BY created_at DESC, event_id DESC
          LIMIT 1 OFFSET 4999
        )
    `).bind(nodeId, nodeId)
  ] : [];
  if (retention.length) await env.DB.batch(retention);

  return json({
    ok: true,
    received: normalized.length,
    discarded: normalized.length - retained.length,
    coalesced,
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
