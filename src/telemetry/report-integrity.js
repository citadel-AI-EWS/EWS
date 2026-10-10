import {sha256Hex, utf8Bytes} from "./common.js";

// Pure validation boundary: no Cloudflare, Drive, D1, or Node-specific APIs.
// The same immutable envelope can later be delivered through another provider.
export const REPORT_INTEGRITY_LIMITS = Object.freeze({
  max_json_bytes: 512 * 1024, max_events_per_batch: 50, max_bundle_batches: 32
});

export class ReportIntegrityError extends Error {
  constructor() {
    super("drive_report_integrity_mismatch");
    this.code = "drive_report_integrity_mismatch";
  }
}

function requireValid(condition) {
  if (!condition) throw new ReportIntegrityError();
}

function parseObject(value) {
  try {
    const object = JSON.parse(value);
    requireValid(object && typeof object === "object" && !Array.isArray(object));
    return object;
  } catch {
    throw new ReportIntegrityError();
  }
}

function checkBatch(batch, nodeId) {
  requireValid(batch && typeof batch === "object" && !Array.isArray(batch));
  requireValid(batch.schema === "citadel-node-report/v1" && batch.node_id === nodeId);
  requireValid(Array.isArray(batch.events) &&
    batch.events.length >= 1 &&
    batch.events.length <= REPORT_INTEGRITY_LIMITS.max_events_per_batch);
  for (const event of batch.events) {
    requireValid(event && typeof event === "object" && !Array.isArray(event) &&
      typeof event.event_id === "string" && event.event_id.length > 0 &&
      typeof event.event_type === "string" && event.event_type.length > 0);
  }
}

/**
 * Verify the immutable queued report immediately before remote upload.
 * v2 member hashes also prove that D1 did not silently change a pending
 * original v1 report BEFORE the v2 bundle hash was calculated.
 * A historical disconnect journal uses "disconnect:" IDs instead of SHA256.
 */
export async function verifyQueuedNodeReport(row) {
  requireValid(row && typeof row === "object" && typeof row.node_id === "string");
  requireValid(typeof row.report_json === "string" && row.report_json.length > 0 &&
    utf8Bytes(row.report_json) <= REPORT_INTEGRITY_LIMITS.max_json_bytes);
  const digest = await sha256Hex(row.report_json);
  if (row.sha256) {
    requireValid(typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256) &&
      row.sha256 === digest);
  }
  const report = parseObject(row.report_json);
  if (report.schema === "citadel-node-report/v1") {
    checkBatch(report, row.node_id);
    requireValid(row.member_ids === undefined || row.member_ids === null);
    return digest;
  }
  requireValid(report.schema === "citadel-node-report/v2" && report.node_id === row.node_id);
  requireValid(Array.isArray(report.batches) && report.batches.length >= 1 &&
    report.batches.length <= REPORT_INTEGRITY_LIMITS.max_bundle_batches);
  requireValid(typeof row.member_ids === "string");
  let memberIds;
  try {memberIds = JSON.parse(row.member_ids);}
  catch {throw new ReportIntegrityError();}
  requireValid(Array.isArray(memberIds) && memberIds.length === report.batches.length);
  for (const [index, batch] of report.batches.entries()) {
    checkBatch(batch, row.node_id);
    const id = memberIds[index];
    requireValid(typeof id === "string");
    if (/^[a-f0-9]{64}$/.test(id)) {
      requireValid((await sha256Hex(JSON.stringify(batch))) === id);
    } else {
      requireValid(id.startsWith("disconnect:") && id.length <= 256 &&
        batch.events.length === 1 && batch.events[0].event_id === id &&
        batch.events[0].event_type === "node_disconnected");
    }
  }
  return digest;
}
