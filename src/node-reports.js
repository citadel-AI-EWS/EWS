import {googleDriveNodeReportFingerprint, googleDriveAllocateReportId, googleDriveWriteNodeReport} from "./index.js";
import {TelemetryError, sanitizeTelemetryValue, sha256Hex} from "./telemetry/common.js";
import {verifyQueuedNodeReport} from "./telemetry/report-integrity.js";

export const REPORT_LIMITS = Object.freeze({pending_bytes: 32 * 1024 * 1024,
  per_node_batches: 64, batch_bytes: 128 * 1024, drain_batches: 3, lease_ms: 180000,
  bundle_batches: 32, bundle_bytes: 256 * 1024});
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
        ON node_report_outbox(node_id, state)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_report_deliveries (
        batch_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, node_name TEXT,
        report_json TEXT NOT NULL, sha256 TEXT NOT NULL DEFAULT '', member_ids TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', drive_file_id TEXT,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        created_at TEXT NOT NULL, delivered_at TEXT
      ) WITHOUT ROWID`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_node_delivery_pending
        ON node_report_deliveries(state, next_attempt_at, created_at)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_report_members (
        batch_id TEXT PRIMARY KEY REFERENCES node_report_outbox(batch_id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL REFERENCES node_report_deliveries(batch_id) ON DELETE CASCADE
      ) WITHOUT ROWID`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_node_report_member_delivery
        ON node_report_members(delivery_id)`)
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

export async function enqueueControllerReport(env, nodeId, eventType, details, createdAt = new Date().toISOString(), nodeName = null, eventId = crypto.randomUUID()) {
  if (!await nodeReportsEnabled(env)) return {status: "awaiting_write_test"};
  await ensureNodeReportStorage(env);
  const event = sanitizeTelemetryValue({event_id: eventId, event_type: eventType,
    level: /failed|disconnect|error/.test(eventType) ? "warn" : "info",
    message: eventType, details, created_at: createdAt});
  const reportJson = JSON.stringify({schema: 'citadel-node-report/v1', node_id: nodeId, events: [event]});
  const size = new TextEncoder().encode(reportJson).length;
  if (size > 8192) throw new TelemetryError(413, 'controller_report_too_large');
  const id = await sha256Hex(reportJson);
  // Controller transitions use a reserved journal path. Agent backpressure must
  // never discard a disconnect which cannot be reconstructed by an agent.
  await env.DB.prepare(`INSERT OR IGNORE INTO node_report_outbox
    (batch_id,node_id,node_name,report_json,sha256,size_bytes,created_at)
    VALUES (?,?,?,?,?,?,?)`).bind(id,nodeId,nodeName,reportJson,id,size,createdAt).run();
  return {status: 'queued', batch_id: id};
}

// Use this INSERT and the status UPDATE in the same D1 transaction. A database
// failure then leaves the transition eligible for the next Guardian attempt.
export function staleNodeReportStatement(env, limit) {
  return env.DB.prepare(`INSERT OR IGNORE INTO node_report_outbox
    (batch_id,node_id,node_name,report_json,sha256,size_bytes,created_at)
    SELECT 'disconnect:' || node_id || ':' || COALESCE(last_seen_at,'never'),
      node_id, hostname, body, '', length(CAST(body AS BLOB)), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (SELECT node_id,hostname,last_seen_at,
      json_object('schema','citadel-node-report/v1','node_id',node_id,'events',json_array(json_object(
        'event_id','disconnect:' || node_id || ':' || COALESCE(last_seen_at,'never'),
        'event_type','node_disconnected','level','warn','message','node_disconnected',
        'created_at',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        'details',json_object('reason','heartbeat_stale','last_seen_at',last_seen_at)))) AS body
      FROM nodes WHERE status = 'online'
        AND (last_seen_at IS NULL OR datetime(last_seen_at) < datetime('now','-5 minutes'))
      ORDER BY last_seen_at ASC, node_id ASC LIMIT ?)` ).bind(limit);
}

function safeErrorCode(error) {
  return /^drive_[a-z_]{1,70}$/.test(error?.code || "") ? error.code : "drive_report_delivery_failed";
}

async function makeDelivery(env, now) {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO node_report_deliveries
      (batch_id,node_id,node_name,report_json,member_ids,created_at)
      SELECT ?,node_id,MAX(node_name),json_object('schema','citadel-node-report/v2','node_id',node_id,
        'batches',json_group_array(json(report_json))),json_group_array(batch_id),MIN(created_at)
      FROM (SELECT *,SUM(size_bytes) OVER (ORDER BY created_at,batch_id) AS bytes
        FROM (SELECT o.* FROM node_report_outbox AS o
          WHERE state='pending' AND drive_file_id IS NULL AND lease_until <= ?
            AND NOT EXISTS (SELECT 1 FROM node_report_members m WHERE m.batch_id=o.batch_id)
            AND node_id=(SELECT p.node_id FROM node_report_outbox p
              WHERE p.state='pending' AND p.drive_file_id IS NULL AND p.lease_until <= ?
                AND NOT EXISTS (SELECT 1 FROM node_report_members m WHERE m.batch_id=p.batch_id)
              ORDER BY p.created_at,p.batch_id LIMIT 1)
          ORDER BY created_at,batch_id LIMIT ?))
      WHERE bytes <= ? GROUP BY node_id`)
      .bind(id,now,now,REPORT_LIMITS.bundle_batches,REPORT_LIMITS.bundle_bytes),
    env.DB.prepare(`INSERT INTO node_report_members(batch_id,delivery_id)
      SELECT value,? FROM node_report_deliveries,json_each(member_ids)
      WHERE node_report_deliveries.batch_id=?`).bind(id,id)
  ]);
}

async function claimDelivery(env, table, now, lease, legacy = false) {
  return (await env.DB.prepare(`UPDATE ${table}
    SET lease_until=?,lease_token=?,attempts=attempts+1
    WHERE batch_id=(SELECT batch_id FROM ${table}
      WHERE state='pending' AND next_attempt_at <= ? AND lease_until <= ?
      ${legacy ? 'AND drive_file_id IS NOT NULL' : ''}
      ORDER BY created_at,batch_id LIMIT 1) RETURNING *`)
    .bind(now+REPORT_LIMITS.lease_ms,lease,now,now).all()).results?.[0];
}

export async function drainNodeReports(env, {now = Date.now(), limit = REPORT_LIMITS.drain_batches} = {}) {
  if (!await nodeReportsEnabled(env)) return {status: "awaiting_write_test", delivered: 0};
  await ensureNodeReportStorage(env);
  let delivered = 0, failed = 0, files = 0;
  for (let i = 0; i < Math.min(REPORT_LIMITS.drain_batches, Math.max(0, limit)); i++) {
    const claimNow = Math.max(now, Date.now());
    const lease = crypto.randomUUID();
    // Finish pre-upgrade uploads with their original immutable body/file ID.
    let table = 'node_report_outbox';
    let row = await claimDelivery(env, table, claimNow, lease, true);
    if (!row) {
      table = 'node_report_deliveries';
      row = await claimDelivery(env, table, claimNow, lease);
      if (!row) {
        await makeDelivery(env, claimNow);
        row = await claimDelivery(env, table, claimNow, lease);
      }
    }
    if (!row) break;
    try {
      // Validate each original hashed batch as well as the aggregated bundle.
      // Mismatches fail closed and retain the pending data for investigation.
      // This is CPU-only verification, with no extra D1 read or write on
      // the usual path when the bundle already has its digest.
      const verifiedDigest = await verifyQueuedNodeReport(row);
      if (!row.sha256) {
        row.sha256 = verifiedDigest;
        await env.DB.prepare(`UPDATE ${table} SET sha256=? WHERE batch_id=? AND lease_token=?`)
          .bind(row.sha256,row.batch_id,lease).run();
      }
      let fileId = row.drive_file_id;
      if (!fileId) {
        fileId = await googleDriveAllocateReportId(env);
        const saved = await env.DB.prepare(`UPDATE ${table} SET drive_file_id = ?
          WHERE batch_id = ? AND lease_token = ?`).bind(fileId, row.batch_id, lease).run();
        if (!saved.meta?.changes) continue;
      }
      const node = row.node_name ? null : await env.DB.prepare(
        "SELECT hostname FROM nodes WHERE node_id = ?").bind(row.node_id).first();
      await googleDriveWriteNodeReport(env, {...row, file_id: fileId, node_name: row.node_name || node?.hostname});
      const commit = env.DB.prepare(`UPDATE ${table}
        SET state = 'delivered', report_json = ''${table === 'node_report_outbox' ? ', size_bytes = 0' : ''}, delivered_at = ?,
          lease_until = 0, lease_token = NULL, last_error_code = NULL
        WHERE batch_id = ? AND lease_token = ?`).bind(new Date(claimNow).toISOString(), row.batch_id, lease);
      if (table === 'node_report_deliveries') {
        const saved = await env.DB.batch([commit, env.DB.prepare(`UPDATE node_report_outbox
          SET state='delivered',report_json='',size_bytes=0,delivered_at=?
          WHERE state='pending' AND batch_id IN (SELECT batch_id FROM node_report_members WHERE delivery_id=?)
            AND EXISTS (SELECT 1 FROM node_report_deliveries WHERE batch_id=? AND state='delivered')`)
          .bind(new Date(claimNow).toISOString(),row.batch_id,row.batch_id)]);
        delivered += Number(saved[1].meta?.changes || 0);
        files += Number(saved[0].meta?.changes || 0);
      } else {
        const saved = await commit.run();
        delivered += Number(saved.meta?.changes || 0); files += Number(saved.meta?.changes || 0);
      }
    } catch (error) {
      failed += 1;
      const backoff = Math.min(3600000, 300000 * 2 ** Math.min(4, row.attempts - 1));
      await env.DB.prepare(`UPDATE ${table}
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
  await env.DB.prepare(`DELETE FROM node_report_deliveries WHERE batch_id IN (
    SELECT batch_id FROM node_report_deliveries WHERE state='delivered'
      AND datetime(delivered_at) < datetime(?,'-7 days') LIMIT 100
  )`).bind(new Date(now).toISOString()).run();
  return {status: failed ? "retry_pending" : "ready", delivered, failed, files};
}
