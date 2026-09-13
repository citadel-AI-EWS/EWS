import {
  TelemetryError,
  authenticateArchitect,
  json,
  parseJsonObject,
  readBodyText,
  safeJson,
  sha256Hex
} from "./telemetry/common.js";
import {
  createGoogleDriveStore,
  googleDriveStorageReady
} from "./google_drive_store.js";

export const REPORT_TIERING = Object.freeze({
  sentinel: '{"$ews_storage":"external"}',
  migrate_batch_max: 50,
  restore_grace_days: 7,
  purge_recovery_minutes: 15,
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

function storeForProvider(env, provider = null) {
  const requested = provider || String(env?.REPORT_STORAGE_PROVIDER || "gdrive").trim();
  if (requested === "gdrive" && googleDriveStorageReady(env)) {
    return createGoogleDriveStore(env);
  }
  if (requested === "r2" && r2Ready(env)) {
    return {
      provider: "r2",
      async put(key, value, metadata) {
        await env.REPORTS.put(key, value, metadata);
        return key;
      },
      get(key) { return env.REPORTS.get(key); },
      delete(key) { return env.REPORTS.delete(key); }
    };
  }
  if (!provider && googleDriveStorageReady(env)) return createGoogleDriveStore(env);
  if (!provider && r2Ready(env)) return storeForProvider(env, "r2");
  return null;
}

function configuredProvider(env) {
  return storeForProvider(env)?.provider || null;
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
          storage_provider TEXT NOT NULL
            CHECK (storage_provider IN ('gdrive', 'r2')),
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
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_report_storage_audit_report_created
        ON report_storage_audit(report_id, created_at DESC)
      `),
      env.DB.prepare(`
        CREATE TRIGGER IF NOT EXISTS report_storage_audit_no_update
        BEFORE UPDATE ON report_storage_audit
        BEGIN
          SELECT RAISE(ABORT, 'report_storage_audit_is_append_only');
        END
      `),
      env.DB.prepare(`
        CREATE TRIGGER IF NOT EXISTS report_storage_audit_no_delete
        BEFORE DELETE ON report_storage_audit
        BEGIN
          SELECT RAISE(ABORT, 'report_storage_audit_is_append_only');
        END
      `)
    ]).then(async () => {
      // CREATE TABLE IF NOT EXISTS cannot upgrade a previously deployed draft
      // schema. Fail health checks until migration 0005 has added the column.
      await env.DB.prepare(
        "SELECT storage_provider FROM report_objects LIMIT 1"
      ).first();
    }).catch((error) => {
      schemaPromises.delete(env.DB);
      throw error;
    });
    schemaPromises.set(env.DB, promise);
  }
  await promise;
}

async function auditStorage(env, reportId, action, objectKey, details = {}, eventId = null) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO report_storage_audit (
      storage_event_id, report_id, action, object_key, details_json
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    eventId || `storage_${crypto.randomUUID()}`,
    reportId,
    action,
    objectKey || null,
    JSON.stringify(details)
  ).run();
}

export function reportObjectKey(reportId, createdAt = "", sha256 = "") {
  const match = String(createdAt).match(/^(\d{4})-(\d{2})/);
  const year = match?.[1] || "unknown-year";
  const month = match?.[2] || "unknown-month";
  const safeId = String(reportId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  const safeHash = String(sha256).replace(/[^a-fA-F0-9]/g, "").slice(0, 16) || "unhashed";
  return `reports/${year}/${month}/${safeId}-${safeHash}.json`;
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
    SELECT report_id, storage_provider, object_key, body_sha256, body_size_bytes,
      state, migrated_at, delete_requested_at, restored_at, purged_at
    FROM report_objects
    WHERE report_id = ?
  `).bind(reportId).first();
}

async function verifyStoredObject(store, objectKey, expectedSha, expectedSize) {
  const object = await store.get(objectKey);
  if (!object) throw new TelemetryError(503, "report_object_missing");
  const body = await object.text();
  const actualSize = new TextEncoder().encode(body).byteLength;
  if (Number(expectedSize) !== actualSize) {
    throw new TelemetryError(503, "report_object_size_mismatch");
  }
  if (await sha256Hex(body) !== expectedSha) {
    throw new TelemetryError(503, "report_object_integrity_error");
  }
  return body;
}

export async function tierReportById(env, reportId) {
  await ensureReportTieringStorage(env);
  const existing = await loadReportObject(env, reportId);
  if (existing) {
    return {
      backend: existing.state === "purged" ? "purged" : existing.storage_provider,
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
  const store = storeForProvider(env);
  if (!store) {
    await auditStorage(env, reportId, "tier.deferred", null, {
      reason: "external_storage_not_configured",
      requested_provider: String(env?.REPORT_STORAGE_PROVIDER || "gdrive")
    });
    return { backend: "d1", state: "deferred", reason: "external_storage_not_configured" };
  }

  const reportJson = String(report.report_json || "null");
  const actualSize = new TextEncoder().encode(reportJson).byteLength;
  const actualSha = await sha256Hex(reportJson);
  if (actualSize !== Number(report.report_size_bytes) || actualSha !== report.report_sha256) {
    throw new TelemetryError(503, "d1_report_integrity_error");
  }

  const logicalKey = reportObjectKey(reportId, report.created_at, report.report_sha256);
  const objectKey = await store.put(logicalKey, reportJson, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      report_id: reportId,
      sha256: report.report_sha256,
      size_bytes: String(report.report_size_bytes),
      sensitivity: String(report.sensitivity || "internal")
    }
  });

  try {
    await verifyStoredObject(store, objectKey, report.report_sha256, report.report_size_bytes);

    const migrationId = `storage_${crypto.randomUUID()}`;
    const [bodyUpdate, objectInsert, auditInsert] = await env.DB.batch([
      env.DB.prepare(`
        UPDATE agent_reports
        SET report_json = ?
        WHERE report_id = ? AND report_json = ?
      `).bind(REPORT_TIERING.sentinel, reportId, reportJson),
      env.DB.prepare(`
        INSERT INTO report_objects (
          report_id, storage_provider, object_key, body_sha256, body_size_bytes, state
        )
        SELECT ?, ?, ?, ?, ?, 'active'
        WHERE EXISTS (
          SELECT 1 FROM agent_reports
          WHERE report_id = ? AND report_json = ?
        )
      `).bind(
        reportId,
        store.provider,
        objectKey,
        report.report_sha256,
        report.report_size_bytes,
        reportId,
        REPORT_TIERING.sentinel
      ),
      env.DB.prepare(`
        INSERT INTO report_storage_audit (
          storage_event_id, report_id, action, object_key, details_json
        )
        SELECT ?, ?, 'tier.migrated', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM report_objects
          WHERE report_id = ? AND object_key = ?
        )
      `).bind(
        migrationId,
        reportId,
        objectKey,
        JSON.stringify({
          storage_provider: store.provider,
          logical_key: logicalKey,
          sha256: report.report_sha256,
          size_bytes: report.report_size_bytes
        }),
        reportId,
        objectKey
      )
    ]);
    if (
      (bodyUpdate?.meta?.changes || 0) !== 1 ||
      (objectInsert?.meta?.changes || 0) !== 1 ||
      (auditInsert?.meta?.changes || 0) !== 1
    ) {
      throw new TelemetryError(409, "report_body_changed_during_tiering");
    }
  } catch (error) {
    const winner = await loadReportObject(env, reportId).catch(() => null);
    if (
      winner?.object_key === objectKey &&
      winner?.storage_provider === store.provider &&
      winner?.body_sha256 === report.report_sha256 &&
      Number(winner?.body_size_bytes) === Number(report.report_size_bytes)
    ) {
      await verifyStoredObject(store, objectKey, report.report_sha256, report.report_size_bytes);
      return {
        backend: winner.state === "purged" ? "purged" : store.provider,
        state: winner.state,
        object_key: objectKey,
        already_tiered: true
      };
    }
    try { await store.delete(objectKey); } catch {}
    throw error;
  }

  return {
    backend: store.provider,
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
      storage: { backend: "d1", state: "deferred", reason: code }
    }, response.status);
  }
}

async function readTieredReportBody(env, report, object) {
  if (!object) {
    if (report.report_json === REPORT_TIERING.sentinel) {
      throw new TelemetryError(503, "report_storage_metadata_missing");
    }
    const body = String(report.report_json || "null");
    if (await sha256Hex(body) !== report.report_sha256) {
      throw new TelemetryError(503, "d1_report_integrity_error");
    }
    return { backend: "d1", body };
  }
  if (object.state === "purged") throw new TelemetryError(410, "report_purged");
  if (object.state === "deleted") throw new TelemetryError(410, "report_deleted");
  const store = storeForProvider(env, object.storage_provider);
  if (!store) throw new TelemetryError(503, "external_storage_not_configured");
  return {
    backend: object.storage_provider,
    body: await verifyStoredObject(
      store,
      object.object_key,
      object.body_sha256,
      object.body_size_bytes
    )
  };
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

  const stored = await readTieredReportBody(
    env,
    report,
    await loadReportObject(env, report.report_id)
  );
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

function optionalQueryString(url, name, maxLength) {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const value = raw.trim();
  if (!value || value.length > maxLength) {
    throw new TelemetryError(400, `invalid_${name}`);
  }
  return value;
}

async function architectListTieredReports(request, env, url) {
  await authenticateArchitect(request, env);
  await ensureReportTieringStorage(env);
  const rawLimit = url.searchParams.get("limit") || "50";
  if (!/^\d{1,3}$/.test(rawLimit)) throw new TelemetryError(400, "invalid_limit");
  const limit = Number(rawLimit);
  if (limit < 1 || limit > 100) throw new TelemetryError(400, "invalid_limit");
  const nodeId = optionalQueryString(url, "node_id", 128);
  const missionId = optionalQueryString(url, "mission_id", 128);
  const reportType = optionalQueryString(url, "report_type", 64);

  const query = await env.DB.prepare(`
    SELECT
      ar.report_id,
      r.result_id,
      r.assignment_id,
      a.mission_id,
      r.node_id,
      r.outcome,
      r.summary,
      r.artifact_key,
      ar.report_type,
      ar.report_sha256,
      ar.report_size_bytes,
      ar.sensitivity,
      ar.created_at,
      CASE
        WHEN ro.report_id IS NULL THEN 'd1'
        WHEN ro.state = 'purged' THEN 'purged'
        ELSE ro.storage_provider
      END AS storage_backend,
      COALESCE(ro.state, 'active') AS storage_state
    FROM agent_reports AS ar
    JOIN results AS r ON r.result_id = ar.result_id
    JOIN assignments AS a ON a.assignment_id = r.assignment_id
    LEFT JOIN report_objects AS ro ON ro.report_id = ar.report_id
    WHERE (? IS NULL OR r.node_id = ?)
      AND (? IS NULL OR a.mission_id = ?)
      AND (? IS NULL OR ar.report_type = ?)
    ORDER BY ar.created_at DESC
    LIMIT ?
  `).bind(
    nodeId,
    nodeId,
    missionId,
    missionId,
    reportType,
    reportType,
    limit
  ).all();
  return json({ ok: true, reports: query.results || [] });
}

async function ensureTieredForLifecycle(env, reportId) {
  let object = await loadReportObject(env, reportId);
  if (object) return object;
  const tiered = await tierReportById(env, reportId);
  if (tiered.backend === "d1") {
    throw new TelemetryError(503, "external_storage_required_for_recoverable_delete");
  }
  object = await loadReportObject(env, reportId);
  if (!object) throw new TelemetryError(503, "report_storage_metadata_missing");
  return object;
}

async function architectDeleteReport(request, env, reportId) {
  await authenticateArchitect(request, env);
  await ensureReportTieringStorage(env);
  if (!await loadReportRow(env, reportId)) {
    throw new TelemetryError(404, "report_not_found");
  }
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

  const changedAt = new Date().toISOString();
  const eventId = `storage_${crypto.randomUUID()}`;
  const [update, audit] = await env.DB.batch([
    env.DB.prepare(`
      UPDATE report_objects
      SET state = 'deleted', delete_requested_at = ?, purged_at = NULL
      WHERE report_id = ? AND state = 'active'
    `).bind(changedAt, reportId),
    env.DB.prepare(`
      INSERT INTO report_storage_audit (
        storage_event_id, report_id, action, object_key, details_json
      )
      SELECT ?, ?, 'lifecycle.delete_requested', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM report_objects
        WHERE report_id = ? AND state = 'deleted' AND delete_requested_at = ?
      )
    `).bind(
      eventId,
      reportId,
      object.object_key,
      JSON.stringify({ restore_grace_days: REPORT_TIERING.restore_grace_days }),
      reportId,
      changedAt
    )
  ]);
  if ((update?.meta?.changes || 0) !== 1 || (audit?.meta?.changes || 0) !== 1) {
    throw new TelemetryError(409, "report_lifecycle_conflict");
  }
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
  const store = storeForProvider(env, object.storage_provider);
  if (!store) throw new TelemetryError(503, "external_storage_not_configured");
  await verifyStoredObject(store, object.object_key, object.body_sha256, object.body_size_bytes);
  const changedAt = new Date().toISOString();
  const eventId = `storage_${crypto.randomUUID()}`;
  const [update, audit] = await env.DB.batch([
    env.DB.prepare(`
      UPDATE report_objects
      SET state = 'active', delete_requested_at = NULL,
          restored_at = ?, purged_at = NULL
      WHERE report_id = ? AND state = 'deleted'
    `).bind(changedAt, reportId),
    env.DB.prepare(`
      INSERT INTO report_storage_audit (
        storage_event_id, report_id, action, object_key, details_json
      )
      SELECT ?, ?, 'lifecycle.restored', ?, '{}'
      WHERE EXISTS (
        SELECT 1 FROM report_objects
        WHERE report_id = ? AND state = 'active' AND restored_at = ?
      )
    `).bind(eventId, reportId, object.object_key, reportId, changedAt)
  ]);
  if ((update?.meta?.changes || 0) !== 1 || (audit?.meta?.changes || 0) !== 1) {
    throw new TelemetryError(409, "report_lifecycle_conflict");
  }
  return json({ ok: true, report_id: reportId, state: "active" });
}

async function architectMigrateReports(request, env) {
  await authenticateArchitect(request, env);
  await ensureReportTieringStorage(env);
  if (!storeForProvider(env)) throw new TelemetryError(503, "external_storage_not_configured");
  const body = parseJsonObject(await readBodyText(request, 4096));
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
  const [reports, sessions, telemetry, audits, databaseBytes] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(*) AS report_count,
        COALESCE(SUM(ar.report_size_bytes), 0) AS report_logical_bytes,
        COALESCE(SUM(CASE WHEN ro.report_id IS NULL THEN ar.report_size_bytes ELSE 0 END), 0)
          AS report_inline_d1_bytes,
        COALESCE(SUM(CASE WHEN ro.state != 'purged' THEN ro.body_size_bytes ELSE 0 END), 0)
          AS report_external_bytes,
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
    env.DB.prepare(`
      SELECT storage_event_id, report_id, action, object_key, details_json, created_at
      FROM report_storage_audit
      ORDER BY created_at DESC
      LIMIT 20
    `).all().catch(() => ({ results: [] })),
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
    storage_provider: String(env?.REPORT_STORAGE_PROVIDER || "gdrive"),
    external_storage_configured: Boolean(configuredProvider(env)),
    google_drive_configured: googleDriveStorageReady(env),
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
      external_bytes: Number(reports?.report_external_bytes || 0),
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
    },
    audit_events: (audits?.results || []).map((event) => ({
      ...event,
      details: safeJson(event.details_json, {}),
      details_json: undefined
    }))
  });
}

export async function purgeExpiredReportObjects(env, limit = 50) {
  await ensureReportTieringStorage(env);
  const query = await env.DB.prepare(`
    SELECT report_id, storage_provider, object_key, state, purged_at
    FROM report_objects
    WHERE (
        state = 'deleted'
        AND datetime(delete_requested_at) <= datetime('now', ?)
      ) OR (
        state = 'purged'
        AND delete_requested_at IS NOT NULL
        AND purged_at IS NOT NULL
        AND datetime(purged_at) <= datetime('now', ?)
      )
    ORDER BY delete_requested_at ASC
    LIMIT ?
  `).bind(
    `-${REPORT_TIERING.restore_grace_days} days`,
    `-${REPORT_TIERING.purge_recovery_minutes} minutes`,
    limit
  ).all();
  let purged = 0;
  for (const row of query.results || []) {
    const store = storeForProvider(env, row.storage_provider);
    if (!store) continue;
    let purgedAt = row.purged_at;
    if (row.state === "deleted") {
      purgedAt = new Date().toISOString();
      const startId = `storage_${crypto.randomUUID()}`;
      const [claim, audit] = await env.DB.batch([
        env.DB.prepare(`
          UPDATE report_objects
          SET state = 'purged', purged_at = ?
          WHERE report_id = ? AND state = 'deleted'
        `).bind(purgedAt, row.report_id),
        env.DB.prepare(`
          INSERT INTO report_storage_audit (
            storage_event_id, report_id, action, object_key, details_json
          )
          SELECT ?, ?, 'lifecycle.purge_started', ?, '{}'
          WHERE EXISTS (
            SELECT 1 FROM report_objects
            WHERE report_id = ? AND state = 'purged' AND purged_at = ?
          )
        `).bind(startId, row.report_id, row.object_key, row.report_id, purgedAt)
      ]);
      if ((claim?.meta?.changes || 0) !== 1 || (audit?.meta?.changes || 0) !== 1) {
        continue;
      }
    }

    try {
      await store.delete(row.object_key);
      const operationHash = await sha256Hex(`${row.report_id}\n${purgedAt}`);
      const [finalize, audit] = await env.DB.batch([
        env.DB.prepare(`
          UPDATE report_objects
          SET delete_requested_at = NULL
          WHERE report_id = ? AND state = 'purged' AND purged_at = ?
        `).bind(row.report_id, purgedAt),
        env.DB.prepare(`
          INSERT OR IGNORE INTO report_storage_audit (
            storage_event_id, report_id, action, object_key, details_json
          )
          SELECT ?, ?, 'lifecycle.purged', ?, '{}'
          WHERE EXISTS (
            SELECT 1 FROM report_objects
            WHERE report_id = ? AND state = 'purged'
              AND purged_at = ? AND delete_requested_at IS NULL
          )
        `).bind(
          `storage_purge_completed_${operationHash}`,
          row.report_id,
          row.object_key,
          row.report_id,
          purgedAt
        )
      ]);
      if ((finalize?.meta?.changes || 0) === 1 && (audit?.meta?.changes || 0) === 1) {
        purged += 1;
      }
    } catch (error) {
      const revertedAt = new Date().toISOString();
      const [revert] = await env.DB.batch([
        env.DB.prepare(`
          UPDATE report_objects
          SET state = 'deleted', purged_at = NULL
          WHERE report_id = ? AND state = 'purged' AND purged_at = ?
        `).bind(row.report_id, purgedAt),
        env.DB.prepare(`
          INSERT INTO report_storage_audit (
            storage_event_id, report_id, action, object_key, details_json
          )
          SELECT ?, ?, 'lifecycle.purge_failed', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM report_objects
            WHERE report_id = ? AND state = 'deleted' AND purged_at IS NULL
          )
        `).bind(
          `storage_${crypto.randomUUID()}`,
          row.report_id,
          row.object_key,
          JSON.stringify({ retry_at: revertedAt }),
          row.report_id
        )
      ]);
      if ((revert?.meta?.changes || 0) !== 1) throw error;
    }
  }
  return { purged };
}

export function isReportTieringArchitectPath(method, pathname) {
  if (method === "GET" && pathname === "/api/v1/architect/storage/tiering") return true;
  if (method === "POST" && pathname === "/api/v1/architect/storage/migrate") return true;
  if (method === "GET" && pathname === "/api/v1/architect/reports") return true;
  if (method === "GET" && /^\/api\/v1\/architect\/reports\/[^/]+$/.test(pathname)) return true;
  if (method === "DELETE" && /^\/api\/v1\/architect\/reports\/[^/]+$/.test(pathname)) return true;
  if (method === "POST" && /^\/api\/v1\/architect\/reports\/[^/]+\/restore$/.test(pathname)) return true;
  return false;
}

export async function handleReportTieringArchitectRequest(request, env, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/v1/architect/storage/tiering") {
      return await architectStorageTiering(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/architect/storage/migrate") {
      return await architectMigrateReports(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/architect/reports") {
      return await architectListTieredReports(request, env, url);
    }

    let match = url.pathname.match(/^\/api\/v1\/architect\/reports\/([^/]+)$/);
    if (match) {
      const reportId = decodeURIComponent(match[1]);
      if (request.method === "GET") {
        return await architectGetTieredReport(request, env, reportId);
      }
      if (request.method === "DELETE") {
        return await architectDeleteReport(request, env, reportId);
      }
    }

    match = url.pathname.match(/^\/api\/v1\/architect\/reports\/([^/]+)\/restore$/);
    if (match && request.method === "POST") {
      return await architectRestoreReport(request, env, decodeURIComponent(match[1]));
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
    provider: String(env?.REPORT_STORAGE_PROVIDER || "gdrive"),
    google_drive: googleDriveStorageReady(env) ? "ready" : "not_configured",
    r2: r2Ready(env) ? "ready" : "not_configured"
  };
}
