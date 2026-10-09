import {googleDriveNodeReportFingerprint, googleDriveAllocateReportId, googleDriveWriteNodeReport} from "./index.js";
import {TelemetryError, sanitizeTelemetryValue, sha256Hex} from "./telemetry/common.js";

export const REPORT_LIMITS = Object.freeze({pending_bytes: 32 * 1024 * 1024,
  per_node_batches: 64, batch_bytes: 128 * 1024, drain_batches: 3, lease_ms: 180000});
const schemas = new WeakMap();

export async function nodeReportsEnabled(env) {
  if (!env.GOOGLE_DRIVE_NODE_REPORTS_VERIFICATION) return false;
  try {
    const proof = JSON.parse(env.GOOGLE_DRIVE_NODE_REPORTS_VERIFICATION);
    return proof.live_write_verified === true && typeof proof.fingerprint === "string" &&
      proof.fingerprint === await googleDriveNodeReportFingerprint(env);
  } catch {return false;}
}

export async function ensureNodeReportStorage(env) {
  if (!schemas.has(env.DB)) {
    const pending = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_report_outbox (
        batch_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, node_name TEXT,
        report_json TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', drive_file_id TEXT,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        created_at TEXT NOT NULL, delivered_at TEXT
      )`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_node_report_pending
        ON node_report_outbox(state, next_attempt_at, created_at)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_node_report_node
        ON node_report_outbox(node_id, state)`)
    ]).catch(error => {schemas.delete(env.DB); throw error;});
    schemas.set(env.DB, pending);
  }
  await schemas.get(env.DB);
}

export async function enqueueNodeReports(env, nodeId, events, nodeName = null) {
  if (!await nodeReportsEnabled(env)) return {status: "awaiting_write_test"};
  if (!Array.isArray(events) || !events.length || events.length > 50) {
    throw new TelemetryError(400, "invalid_report_events");
  }
  const safeEvents = events.map(({details_json, ...event}) => sanitizeTelemetryValue(event));
  const reportJson = JSON.stringify({schema: "citadel-node-report/v1", node_id: nodeId, events: safeEvents});
  const size = new TextEncoder().encode(reportJson).length;
  if (size > REPORT_LIMITS.batch_bytes) throw new TelemetryError(413, "node_report_too_large");
  const batchId = await sha256Hex(reportJson);
  await ensureNodeReportStorage(env);
  // One atomic statement bounds temporary payload storage even when several
  // agents enqueue concurrently. Duplicate retries remain acknowledged when
  // the queue is full because their bytes have already been committed.
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO node_report_outbox
    (batch_id, node_id, node_name, report_json, sha256, size_bytes, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE COALESCE((SELECT SUM(size_bytes) FROM node_report_outbox WHERE state = 'pending'), 0) + ? <= ?
      AND (SELECT COUNT(*) FROM node_report_outbox WHERE node_id = ? AND state = 'pending') < ?
  `).bind(batchId, nodeId, nodeName, reportJson, batchId, size, events[0].created_at || new Date().toISOString(),
    size, REPORT_LIMITS.pending_bytes, nodeId, REPORT_LIMITS.per_node_batches).run();
  if (!result.meta?.changes) {
    const existing = await env.DB.prepare("SELECT state FROM node_report_outbox WHERE batch_id = ?").bind(batchId).first();
    if (!existing) throw new TelemetryError(503, "node_report_queue_full", {"retry-after": "300"});
    return {status: existing.state, batch_id: batchId, duplicate: true};
  }
  return {status: "queued", batch_id: batchId};
}

export async function enqueueControllerReport(env, nodeId, eventType, details, createdAt = new Date().toISOString(), nodeName = null) {
  return enqueueNodeReports(env, nodeId, [{event_id: crypto.randomUUID(), event_type: eventType,
    level: /failed|disconnect|error/.test(eventType) ? "warn" : "info",
    message: eventType, details, created_at: createdAt}], nodeName);
}

function safeErrorCode(error) {
  return /^drive_[a-z_]{1,70}$/.test(error?.code || "") ? error.code : "drive_report_delivery_failed";
}

export async function drainNodeReports(env, {now = Date.now(), limit = REPORT_LIMITS.drain_batches} = {}) {
  if (!await nodeReportsEnabled(env)) return {status: "awaiting_write_test", delivered: 0};
  await ensureNodeReportStorage(env);
  let delivered = 0, failed = 0;
  for (let i = 0; i < Math.min(REPORT_LIMITS.drain_batches, Math.max(0, limit)); i++) {
    const claimNow = Math.max(now, Date.now());
    const lease = crypto.randomUUID();
    const claim = await env.DB.prepare(`UPDATE node_report_outbox
      SET lease_until = ?, lease_token = ?, attempts = attempts + 1
      WHERE batch_id = (SELECT batch_id FROM node_report_outbox
        WHERE state = 'pending' AND next_attempt_at <= ? AND lease_until <= ?
        ORDER BY created_at, batch_id LIMIT 1)
      RETURNING *`).bind(claimNow + REPORT_LIMITS.lease_ms, lease, claimNow, claimNow).all();
    const row = claim.results?.[0];
    if (!row) break;
    try {
      let fileId = row.drive_file_id;
      if (!fileId) {
        fileId = await googleDriveAllocateReportId(env);
        const saved = await env.DB.prepare(`UPDATE node_report_outbox SET drive_file_id = ?
          WHERE batch_id = ? AND lease_token = ?`).bind(fileId, row.batch_id, lease).run();
        if (!saved.meta?.changes) continue;
      }
      const node = row.node_name ? null : await env.DB.prepare(
        "SELECT hostname FROM nodes WHERE node_id = ?").bind(row.node_id).first();
      await googleDriveWriteNodeReport(env, {...row, file_id: fileId, node_name: row.node_name || node?.hostname});
      const saved = await env.DB.prepare(`UPDATE node_report_outbox
        SET state = 'delivered', report_json = '', size_bytes = 0, delivered_at = ?,
          lease_until = 0, lease_token = NULL, last_error_code = NULL
        WHERE batch_id = ? AND lease_token = ?`).bind(new Date(claimNow).toISOString(), row.batch_id, lease).run();
      delivered += Number(saved.meta?.changes || 0);
    } catch (error) {
      failed += 1;
      const backoff = Math.min(3600000, 300000 * 2 ** Math.min(4, row.attempts - 1));
      await env.DB.prepare(`UPDATE node_report_outbox
        SET next_attempt_at = ?, lease_until = 0, lease_token = NULL, last_error_code = ?
        WHERE batch_id = ? AND lease_token = ?`)
        .bind(claimNow + backoff, safeErrorCode(error), row.batch_id, lease).run();
    }
  }
  // Delivered metadata is small and retained for deduplication. Pending bodies
  // never expire: backpressure keeps new data on the agents instead of dropping it.
  await env.DB.prepare(`DELETE FROM node_report_outbox WHERE batch_id IN (
    SELECT batch_id FROM node_report_outbox WHERE state = 'delivered'
      AND datetime(delivered_at) < datetime(?, '-7 days') LIMIT 100
  )`).bind(new Date(now).toISOString()).run();
  return {status: failed ? "retry_pending" : "ready", delivered, failed};
}
