// Explicit replay-store migration, never a fallback after an ambiguous DO write.
export const REPLAY_MIGRATION_ID = 'd1-compact-v1';
export const REPLAY_DRAIN_SECONDS = 630;
const MAX_ACTIVE_NONCES = 256;

export class ReplayStoreError extends Error {
  constructor(status, code, retry = 0) {
    super(code); this.status = status; this.code = code;
    this.retry_after_seconds = Math.max(0, Math.ceil(retry));
  }
}

export function compactReplayConfigured(env) {
  return env.NODE_REPLAY_BACKEND === 'd1_compact';
}

export async function compactReplayStatus(env, now = Math.floor(Date.now() / 1000)) {
  if (!compactReplayConfigured(env)) return {backend: 'durable_objects', status: 'unverified'};
  try {
    const row = await env.DB.prepare('SELECT not_before FROM node_replay_migrations WHERE migration_id = ?')
      .bind(REPLAY_MIGRATION_ID).first();
    if (!Number.isSafeInteger(row?.not_before) || row.not_before < 1) {
      return {backend: 'd1_compact', status: 'awaiting_migration', retry_after_seconds: 30};
    }
    if (now < row.not_before) return {backend: 'd1_compact', status: 'draining',
      ready_at: new Date(row.not_before * 1000).toISOString(), retry_after_seconds: row.not_before - now};
    return {backend: 'd1_compact', status: 'ready', minimum_signature_timestamp: row.not_before};
  } catch {
    return {backend: 'd1_compact', status: 'unavailable', retry_after_seconds: 30};
  }
}

export async function claimCompactReplay(env, nodeId, requestId, timestampSeconds,
    now = Math.floor(Date.now() / 1000)) {
  const state = await compactReplayStatus(env, now);
  if (state.status !== 'ready') {
    throw new ReplayStoreError(503, 'node_replay_' + state.status, state.retry_after_seconds);
  }
  // Requests signed before the old store was drained stay rejected permanently.
  if (timestampSeconds < state.minimum_signature_timestamp) {
    throw new ReplayStoreError(401, 'signature_before_replay_cutover');
  }
  const expiry = Math.max(now + 330, timestampSeconds + 301);
  const path = '$."' + requestId + '"';
  // SQLite serializes this one conditional UPSERT. Each node has one unindexed
  // JSON row; expired claims are removed in the same write, with no nonce DELETEs.
  const row = await env.DB.prepare(`INSERT INTO node_replay_windows (node_id, claims_json)
    VALUES (?, json_object(?, ?))
    ON CONFLICT(node_id) DO UPDATE SET claims_json = json_set(
      (SELECT COALESCE(json_group_object(key, value), '{}')
       FROM json_each(node_replay_windows.claims_json) WHERE value > ?), ?, ?)
    WHERE (json_extract(node_replay_windows.claims_json, ?) IS NULL
      OR json_extract(node_replay_windows.claims_json, ?) <= ?)
      AND (SELECT COUNT(*) FROM json_each(node_replay_windows.claims_json) WHERE value > ?) < ?
    RETURNING node_id`)
    .bind(nodeId, requestId, expiry, now, path, expiry, path, path, now, now, MAX_ACTIVE_NONCES).first();
  if (row) return true;
  const previous = await env.DB.prepare(
    'SELECT json_extract(claims_json, ?) AS expiry FROM node_replay_windows WHERE node_id = ?')
    .bind(path, nodeId).first();
  if (Number(previous?.expiry || 0) > now) return false;
  throw new ReplayStoreError(429, 'node_request_rate_limited', 30);
}
