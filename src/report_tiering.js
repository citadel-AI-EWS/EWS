import {
  TelemetryError,
  authenticateArchitect,
  json,
  parseJsonObject,
  readBodyText,
  safeJson,
  sha256Hex
} from "./telemetry/common.js";

export const REPORT_TIERING = Object.freeze({
  sentinel: '{"$ews_storage":"r2"}',
  migrate_batch_max: 50,
  restore_grace_days: 7,
  d1_database_limit_bytes: 500 * 1024 * 1024,
  d1_operating_target_bytes: 400 * 1024 * 1024,
  warning_percentages: [60, 75, 80]
});

const schemaPromises = new WeakMap();

function r2Ready(env) {
  return Boolean(
    env?.REPORTS &&
    typeof env.REPORTS.put === "function" &&
    typeof env.REPORTS.get === "function" &&
    typeof env.REPORTS.delete === "function"
  );
}

export async function ensureReportTieringStorage(env) {
  if (!env?.DB || (typeof env.DB !== "object" && typeof env.DB !== "function")) {
    throw new TelemetryError(503, "database_not_configured");
  }
  let promise = schemaPromises.get(env.DB);
  if (!promise) {
    promise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS report_objects (
          report_id TEXT PRIMARY KEY,
          object_key TEXT NOT NULL UNIQUE,
          body_sha256 TEXT NOT NULL,
          body_size_bytes INTEGER NOT NULL CHECK (body_size_bytes >= 0),
          state TEXT NOT NULL DEFAULT 'active'
            CHECK (state IN ('active', 'deleted', 'purged')),
          migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          delete_requested_at TEXT,
          restored_at TEXT,
          purged_at TEXT,
          FOREIGN KEY (report_id) REFERENCES agent_reports(report_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_report_objects_state_migrated
        ON report_objects(state, migrated_at DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_report_objects_delete_requested
        ON report_objects(state, delete_requested_at)
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS report_storage_audit (
          storage_event_id TEXT PRIMARY KEY,
          report_id TEXT NOT NULL,
          action TEXT NOT NULL,
          object_key TEXT,
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (report_id) REFERENCES agent_reports(report_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_report_storage_audit_report_created
        ON report_storage_audit(report_id, created_at DESC)
      `)
    ]).catch((error) => {
      schemaPromises.delete(env.DB);
      throw error;
    });
    schemaPromises.set(env.DB, promise);
  }
  await promise;
}

async function auditStorage(env, reportId, action, objectKey, details = {}) {
  await env.DB.prepare(`
    INSERT INTO report_storage_audit (
      storage_event_id, report_id, action, object_key, details_json
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    `storage_${crypto.randomUUID()}`,
    reportId,
    action,
    objectKey || null,
    JSON.stringify(details)
  ).run();
}

export function reportObjectKey(reportId, createdAt = "") {
  const match = String(createdAt).match(/^(\d{4})-(\d{2})/);
  const year = match?.[1] || "unknown-year";
  const month = match?.[2] || "unknown-month";
  const safeId = String(reportId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  return `reports/${year}/${month}/${safeId}.json`;
}

async function loadReportRow(env, reportId) {
  return env.DB.prepare(`
    SELECT report_id, result_id, assignment_id, mission_id, node_id,
      report_type, report_json, report_sha256, report_size_bytes,
      sensitivity, created_at
    FROM agent_reports
    WHERE report_id = ?
  `).bind(reportId).first();
}

async function loadReportObject(env, reportId) {
  return env.DB.prepare(`
    SELECT report_id, object_key, body_sha256, body_size_bytes,
      state, migrated_at, delete_requested_at, restored_at, purged_at
    FROM report_objects
    WHERE report_id = ?
  `).bind(reportId).first();
}

async function verifyR2Object(env, objectKey, expectedSha, expectedSize) {
  const object = await env.REPORTS.get(objectKey);
  if (!object) throw new TelemetryError(503, "report_object_missing");
  const body = await object.text();
  const actualSize = new TextEncoder().encode(body).byteLength;
  if (Number(expectedSize) !== actualSize) {
    throw new TelemetryError(503, "report_object_size_mismatch");
  }
  const actualSha = await sha256Hex(body);
  if (actualSha !== expectedSha) {
    throw new TelemetryError(503, "report_object_integrity_error");
  }
  return body;
}

export async function tierReportById(env, reportId) {
  await ensureReportTieringStorage(env);
  const existing = await loadReportObject(env, reportId);
  if (existing) {
    return {
      backend: existing.state === "purged" ? "purged" : "r2",
      state: existing.state,
      object_key: existing.object_key,
      already_tiered: true
    };
  }

  const report = await loadReportRow(env, reportId);
  if (!report) throw new TelemetryError(404, "report_not_found");
  if (report.report_json === REPORT_TIERING.sentinel) {
    throw new TelemetryError(503, "report_storage_metadata_missing");
  }
  if (!r2Ready(env)) {
    await auditStorage(env, reportId, "tier.deferred", null, {
      reason: "r2_not_configured"
    });
    return { backend: "d1", state: "deferred", reason: "r2_not_configured" };
  }

  const reportJson = String(report.report_json || "null");
  const actualSize = new TextEncoder().encode(reportJson).byteLength;
  const actualSha = await sha256Hex(reportJson);
  if (actualSize !== Number(report.report_size_bytes) || actualSha !== report.report_sha256) {
    throw new TelemetryError(503, "d1_report_integrity_error");
  }

  const objectKey = reportObjectKey(reportId, report.created_at);
  await env.REPORTS.put(objectKey, reportJson, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      report_id: reportId,
      sha256: report.report_sha256,
      size_bytes: String(report.report_size_bytes),
      sensitivity: String(report.sensitivity || "internal")
    }
  });

  try {
    await verifyR2Object(
      env,
      objectKey,
      report.report_sha256,
      report.report_size_bytes
    );

    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO report_objects (
          report_id, object_key, body_sha256, body_size_bytes, state
        ) VALUES (?, ?, ?, ?, 'active')
      `).bind(
        reportId,
        objectKey,
        report.report_sha256,
        report.report_size_bytes
      ),
      env.DB.prepare(`
        UPDATE agent_reports
        SET report_json = ?
        WHERE report_id = ? AND report_json = ?
      `).bind(REPORT_TIERING.sentinel, reportId, reportJson),
      env.DB.prepare(`
        INSERT INTO report_storage_audit (
          storage_event_id, report_id, action, object_key, details_json
        ) VALUES (?, ?, 'tier.migrated', ?, ?)
      `).bind(
        `storage_${crypto.randomUUID()}`,
        reportId,
        objectKey,
        JSON.stringify({
          sha256: report.report_sha256,
          size_bytes: report.report_size_bytes
        })
      )
    ]);
    if ((results[1]?.meta?.changes || 0) !== 1) {
      throw new Error("report_body_changed_during_tiering");
    }
  } catch (error) {
    try { await env.REPORTS.delete(objectKey); } catch {}
    throw error;
  }

  return {
    backend: "r2",
    state: "active",
    object_key: objectKey,
    already_tiered: false
  };
}

async function reportIdForResult(env, resultId) {
  if (!resultId) return null;
  const row = await env.DB.prepare(
    "SELECT report_id FROM agent_reports WHERE result_id = ?"
  ).bind(resultId).first();
  return row?.report_id || null;
}

export async function tierResultResponse(response, env) {
  if (![200, 201].includes(response.status)) return response;
  let body;
  try { body = await response.clone().json(); } catch { return response; }
  let reportId = body?.result?.report_id || null;
  if (!reportId && body?.result?.result_id) {
    reportId = await reportIdForResult(env, body.result.result_id);
  }
  if (!reportId) return response;

  try {
    const storage = await tierReportById(env, reportId);
    return json({ ...body, storage }, response.status);
  } catch (error) {
    const code = error instanceof TelemetryError
      ? error.code
      : "report_tiering_failed";
    return json({
      ...body,
      storage: {
        backend: "d1",
        state: "deferred",
        reason: code
      }
    }, response.status);
  }
}

async function readTieredReportBody(env, report, object) {
  if (!object) {
    if (report.report_json === REPORT_TIERING.sentinel) {
      throw new TelemetryError(503, "report_storage_metadata_missing");
    }
    const body = String(report.report_json || "null");
    const sha = await sha256Hex(body);
    if (sha !== report.report_sha256) {
      throw new TelemetryError(503, "d1_report_integrity_error");
    }
    return { backend: "d1", body };
  }
  if (object.state === "purged") {
    throw new TelemetryError(410, "report_purged");
  }
  if (object.state === "deleted") {
    throw new TelemetryError(410, "report_deleted");
  }
  if (!r2Ready(env)) {
    throw new TelemetryError(503, "r2_not_configured");
  }
  const body = await verifyR2Object(
    env,
    object.object_key,
    object.body_sha256,
    object.body_size_bytes
  );
  return { backend: "r2", body };
}

async function architectGetTieredReport(request, env, reportId) {
  await authenticateArchitect(request, env);
  await ensureReportTieringStorage(env);
  const report = await env.DB.prepare(`
    SELECT
      ar.report_id,
      r.result_id,
      r.assignment_id,
      a.mission_id,
      r.node_id,
      r.outcome,
      r.summary,
      r.artifact_key,
      r.metrics_json,
      ar.report_type,
      ar.report_json,
      ar.report_sha256,
      ar.report_size_bytes,
      ar.sensitivity,
      ar.created_at
    FROM agent_reports AS ar
    JOIN results AS r ON r.result_id = ar.result_id
    JOIN assignments AS a ON a.assignment_id = r.assignment_id
    WHERE ar.report_id = ? OR r.result_id = ?
  `).bind(reportId, reportId).first();
  if (!report) throw new TelemetryError(404, "report_not_found");

  const object = await loadReportObject(env, report.report_id);
  const stored = await readTieredReportBody(env, report, object);
  return json({
    ok: true,
    report: {
      report_id: report.report_id,
      result_id: report.result_id,
      assignment_id: report.assignment_id,
      mission_id: report.mission_id,
      node_id: report.node_id,
      outcome: report.outcome,
      summary: report.summary,
      artifact_key: report.artifact_key,
      metrics: safeJson(report.metrics_json, {}),
      report_type: report.report_type,
      report_sha256: report.report_sha256,
      report_size_bytes: report.report_size_bytes,
      sensitivity: report.sensitivity,
      created_at: report.created_at,
      storage_backend: stored.backend,
      content: safeJson(stored.body, null)
    }
  });
}

async function ensureTieredForLifecycle(env, reportId) {
  let object = await loadReportObject(env, reportId);
  if (object) return object;
  const tiered = await tierReportById(env, reportId);
  if (tiered.backend !== "r2") {
    throw new TelemetryError(503, "r2_required_for_recoverable_delete");
  }
  object = await loadReportObject(env, reportId);
  if (!object) throw new TelemetryError(503, "report_storage_metadata_missing");
  return object;
}

async function architectDeleteReport(request, env, reportId) {
  await authenticateArchitect(request, env);
  await ensureReportTieringStorage(env);
  const report = await loadReportRow(env, reportId);
  if (!report) throw new TelemetryError(404, "report_not_found");
  const object = await ensureTieredForLifecycle(env, reportId);
  if (object.state === "purged") throw new TelemetryError(410, "report_purged");
  if (object.state === "deleted") {
    return json({
      ok: true,
      report_id: reportId,
      state: "deleted",
      restore_grace_days: REPORT_TIERING.restore_grace_days,
      duplicate: true
    });
  }

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE report_objects
      SET state = 'deleted', delete_requested_at = CURRENT_TIMESTAMP
      WHERE report_id = ? AND state = 'active'
    `).bind(reportId),
    env.DB.prepare(`
      INSERT INTO report_storage_audit (
        storage_event_id, report_id, action, object_key, details_json
      ) VALUES (?, ?, 'lifecycle.delete_requested', ?, ?)
    `).bind(
      `storage_${crypto.randomUUID()}`,
      reportId,
      object.object_key,
      JSON.stringify({ restore_grace_days: REPORT_TIERING.restore_grace_days })
    )
  ]);
  return json({
    ok: true,
    report_id: reportId,
    state: "deleted",
    restore_grace_days: REPORT_TIERING.restore_grace_days
  }, 202);
}

async function architectRestoreReport(request, env, reportId) {
  await authenticateArchitect(request, env);
  await ensureReportTieringStorage(env);
  const object = await loadReportObject(env, reportId);
  if (!object) throw new TelemetryError(404, "report_not_found");
  if (object.state === "purged") throw new TelemetryError(410, "report_purged");
  if (object.state === "active") {
    return json({ ok: true, report_id: reportId, state: "active", duplicate: true });
  }
  if (!r2Ready(env)) throw new TelemetryError(503, "r2_not_configured");
  await verifyR2Object(env, object.object_key, object.body_sha256, object.body_size_bytes);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE report_objects
      SET state = 'active', delete_requested_at = NULL,
          restored_at = CURRENT_TIMESTAMP
      WHERE report_id = ? AND state = 'deleted'
    `).bind(reportId),
    env.DB.prepare(`
      INSERT INTO report_storage_audit (
        storage_event_id, report_id, action, object_key, details_json
      ) VALUES (?, ?, 'lifecycle.restored', ?, '{}')
    `).bind(`storage_${crypto.randomUUID()}`, reportId, object.object_key)
  ]);
  return json({ ok: true, report_id: reportId, state: "active" });
}

async function architectMigrateReports(request, env) {
  await authenticateArchitect(request, env);
  await ensureReportTieringStorage(env);
  if (!r2Ready(env)) throw new TelemetryError(503, "r2_not_configured");
  const bodyText = await readBodyText(request, 4096);
  const body = parseJsonObject(bodyText);
  const limit = body.limit === undefined ? 20 : body.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > REPORT_TIERING.migrate_batch_max) {
    throw new TelemetryError(400, "invalid_limit");
  }
  const query = await env.DB.prepare(`
    SELECT ar.report_id
    FROM agent_reports AS ar
    LEFT JOIN report_objects AS ro ON ro.report_id = ar.report_id
    WHERE ro.report_id IS NULL
      AND ar.report_json != ?
    ORDER BY ar.created_at ASC
    LIMIT ?
  `).bind(REPORT_TIERING.sentinel, limit).all();

  const results = [];
  for (const row of query.results || []) {
    try {
      results.push({
        report_id: row.report_id,
        ok: true,
        storage: await tierReportById(env, row.report_id)
      });
    } catch (error) {
      results.push({
        report_id: row.report_id,
        ok: false,
        error: error instanceof TelemetryError ? error.code : "migration_failed"
      });
      break;
    }
  }
  return json({
    ok: results.every((item) => item.ok),
    attempted: results.length,
    migrated: results.filter((item) => item.ok).length,
    results
  }, results.some((item) => !item.ok) ? 207 : 200);
}

function storageWarning(percentage) {
  if (percentage >= 80) return "guard";
  if (percentage >= 75) return "warning";
  if (percentage >= 60) return "watch";
  return "ok";
}

async function pragmaDatabaseBytes(env) {
  try {
    const count = await env.DB.prepare("PRAGMA page_count").first();
    const size = await env.DB.prepare("PRAGMA page_size").first();
    const pageCount = Number(count?.page_count);
    const pageSize = Number(size?.page_size);
    if (Number.isFinite(pageCount) && Number.isFinite(pageSize) && pageCount >= 0 && pageSize > 0) {
      return pageCount * pageSize;
    }
  } catch {}
  return null;
}

async function architectStorageTiering(request, env) {
  await authenticateArchitect(request, env);
  await ensureReportTieringStorage(env);
  const [reports, sessions, telemetry, databaseBytes] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(*) AS report_count,
        COALESCE(SUM(ar.report_size_bytes), 0) AS report_logical_bytes,
        COALESCE(SUM(CASE WHEN ro.report_id IS NULL THEN ar.report_size_bytes ELSE 0 END), 0)
          AS report_inline_d1_bytes,
        COALESCE(SUM(CASE WHEN ro.state != 'purged' THEN ro.body_size_bytes ELSE 0 END), 0)
          AS report_r2_bytes,
        COALESCE(SUM(CASE WHEN ro.report_id IS NOT NULL THEN 1 ELSE 0 END), 0)
          AS tiered_report_count,
        COALESCE(SUM(CASE WHEN ro.state = 'deleted' THEN 1 ELSE 0 END), 0)
          AS pending_delete_count
      FROM agent_reports AS ar
      LEFT JOIN report_objects AS ro ON ro.report_id = ar.report_id
    `).first(),
    env.DB.prepare(`
      SELECT COUNT(*) AS session_count,
        COALESCE(SUM(snapshot_size_bytes), 0) AS session_bytes
      FROM architect_sessions
    `).first().catch(() => ({ session_count: 0, session_bytes: 0 })),
    env.DB.prepare(`
      SELECT COUNT(*) AS telemetry_event_count,
        COALESCE(SUM(LENGTH(message) + LENGTH(details_json)), 0) AS telemetry_known_bytes
      FROM node_logs
    `).first().catch(() => ({ telemetry_event_count: 0, telemetry_known_bytes: 0 })),
    pragmaDatabaseBytes(env)
  ]);

  const fallbackKnownBytes =
    Number(reports?.report_inline_d1_bytes || 0) +
    Number(sessions?.session_bytes || 0) +
    Number(telemetry?.telemetry_known_bytes || 0);
  const measured = databaseBytes !== null;
  const d1Bytes = measured ? databaseBytes : fallbackKnownBytes;
  const percentage = Number((
    (d1Bytes / REPORT_TIERING.d1_database_limit_bytes) * 100
  ).toFixed(2));

  return json({
    ok: true,
    r2_configured: r2Ready(env),
    d1: {
      bytes: d1Bytes,
      source: measured ? "pragma" : "known_payload_fallback",
      database_limit_bytes: REPORT_TIERING.d1_database_limit_bytes,
      operating_target_bytes: REPORT_TIERING.d1_operating_target_bytes,
      percent_of_database_limit: percentage,
      warning: storageWarning(percentage),
      warning_percentages: REPORT_TIERING.warning_percentages
    },
    reports: {
      count: Number(reports?.report_count || 0),
      logical_bytes: Number(reports?.report_logical_bytes || 0),
      inline_d1_bytes: Number(reports?.report_inline_d1_bytes || 0),
      r2_bytes: Number(reports?.report_r2_bytes || 0),
      tiered_count: Number(reports?.tiered_report_count || 0),
      pending_delete_count: Number(reports?.pending_delete_count || 0)
    },
    sessions: {
      count: Number(sessions?.session_count || 0),
      bytes: Number(sessions?.session_bytes || 0)
    },
    telemetry: {
      event_count: Number(telemetry?.telemetry_event_count || 0),
      known_bytes: Number(telemetry?.telemetry_known_bytes || 0)
    }
  });
}

export async function purgeExpiredReportObjects(env, limit = 50) {
  await ensureReportTieringStorage(env);
  if (!r2Ready(env)) return { purged: 0, skipped: "r2_not_configured" };
  const query = await env.DB.prepare(`
    SELECT report_id, object_key
    FROM report_objects
    WHERE state = 'deleted'
      AND datetime(delete_requested_at) <= datetime('now', ?)
    ORDER BY delete_requested_at ASC
    LIMIT ?
  `).bind(`-${REPORT_TIERING.restore_grace_days} days`, limit).all();
  let purged = 0;
  for (const row of query.results || []) {
    await env.REPORTS.delete(row.object_key);
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE report_objects
        SET state = 'purged', purged_at = CURRENT_TIMESTAMP
        WHERE report_id = ? AND state = 'deleted'
      `).bind(row.report_id),
      env.DB.prepare(`
        INSERT INTO report_storage_audit (
          storage_event_id, report_id, action, object_key, details_json
        ) VALUES (?, ?, 'lifecycle.purged', ?, '{}')
      `).bind(`storage_${crypto.randomUUID()}`, row.report_id, row.object_key)
    ]);
    purged += 1;
  }
  return { purged };
}

export function isReportTieringArchitectPath(method, pathname) {
  if (method === "GET" && pathname === "/api/v1/architect/storage/tiering") return true;
  if (method === "POST" && pathname === "/api/v1/architect/storage/migrate") return true;
  if (method === "GET" && /^\/api\/v1\/architect\/reports\/[^/]+$/.test(pathname)) return true;
  if (method === "DELETE" && /^\/api\/v1\/architect\/reports\/[^/]+$/.test(pathname)) return true;
  if (method === "POST" && /^\/api\/v1\/architect\/reports\/[^/]+\/restore$/.test(pathname)) return true;
  return false;
}

export async function handleReportTieringArchitectRequest(request, env, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/v1/architect/storage/tiering") {
      return architectStorageTiering(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/architect/storage/migrate") {
      return architectMigrateReports(request, env);
    }

    let match = url.pathname.match(/^\/api\/v1\/architect\/reports\/([^/]+)$/);
    if (match) {
      const reportId = decodeURIComponent(match[1]);
      if (request.method === "GET") return architectGetTieredReport(request, env, reportId);
      if (request.method === "DELETE") return architectDeleteReport(request, env, reportId);
    }

    match = url.pathname.match(/^\/api\/v1\/architect\/reports\/([^/]+)\/restore$/);
    if (match && request.method === "POST") {
      return architectRestoreReport(request, env, decodeURIComponent(match[1]));
    }
    return json({ ok: false, error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof TelemetryError) {
      return json({ ok: false, error: error.code }, error.status);
    }
    console.error("Unhandled report tiering error", error);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

export async function reportTieringHealth(env) {
  const schema = await ensureReportTieringStorage(env)
    .then(() => "ready")
    .catch(() => "unavailable");
  return {
    schema,
    r2: r2Ready(env) ? "ready" : "not_configured"
  };
}
