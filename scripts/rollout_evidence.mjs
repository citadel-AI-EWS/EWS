import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const publicX = 'erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0';
const digest = value => createHash('sha256').update(value).digest('hex');
const sqlString = value => "'" + String(value).replaceAll("'", "''") + "'";
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };

// Public Actions output contains fixed codes only, never exception text, paths,
// addresses, identifiers or the private signing key.
export function failureCode(error) {
  const value = String(error || '');
  if (value.includes('updated agent startup health-check failed')) return 'startup_healthcheck_failed';
  if (value.includes('updated agent self-test failed')) return 'self_test_failed';
  if (value.includes('update hash mismatch: citadel_node_v1.py')) return 'core_v1_hash_mismatch';
  if (value.includes('update hash mismatch: citadel_node_v2.py')) return 'core_v2_hash_mismatch';
  if (value.includes('invalid update payload')) return 'invalid_update_payload';
  if (value.includes('event_type_not_allowed')) return 'telemetry_event_rejected';
  if (value.includes('node_replay_store_unavailable')) return 'replay_store_unavailable';
  if (value.includes('d1_daily_write_limit_exceeded')) return 'd1_write_quota';
  if (/WinError 5\b|PermissionError|Permission denied|Access is denied/i.test(value)) return 'file_access_denied';
  if (/WinError 32\b|being used by another process/i.test(value)) return 'file_locked';
  if (/CERTIFICATE_VERIFY_FAILED|certificate verify failed/.test(value)) return 'tls_certificate_rejected';
  if (/timed out|WinError 10060|TimeoutExpired/i.test(value)) return 'timeout';
  const download = value.match(/update download failed: HTTP (\d{3})/);
  if (download) return 'download_http_' + download[1];
  return value ? 'unclassified_error' : 'no_error_detail';
}

export function summarizeFailure(events, commandId) {
  const failure = events.find(event => event.event_type === 'command_failed' &&
    parse(event.details_json).command_id === commandId);
  return {
    latest_telemetry_at: events[0]?.created_at || null,
    matching_failure_logged: Boolean(failure),
    failure_code: failure ? failureCode(parse(failure.details_json).error) : null
  };
}

export function eligibleDiagnosticPause(node, command, expectedHash, now = Date.now()) {
  // This lease applies only to the single diagnostic hold created in this
  // repair session. A later owner command, manual pause, or another node is
  // never resumed. The recovery itself expires on October 9 UTC.
  return now < Date.parse('2026-10-09T00:00:00Z') &&
    typeof expectedHash === 'string' && /^[0-9a-f]{64}$/.test(expectedHash) &&
    digest(node?.node_id || '') === expectedHash && node?.status === 'paused' &&
    command?.command_type === 'pause' && command.status === 'completed' &&
    Date.parse(command.created_at) >= Date.parse('2026-10-08T13:40:00Z') &&
    Date.parse(command.created_at) <= Date.parse('2026-10-08T13:46:00Z');
}

export function signedResume(nodeId, pauseId, encodedKey, createdAt) {
  let encoded = String(encodedKey || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let jwk = JSON.parse(encoded);
  if (typeof jwk === 'string') jwk = JSON.parse(jwk);
  if (jwk?.kty !== 'OKP' || jwk.crv !== 'Ed25519' || jwk.x !== publicX || typeof jwk.d !== 'string') {
    throw new Error('signing_key_invalid');
  }
  const key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }, format: 'jwk' });
  if (createPublicKey(key).export({ format: 'jwk' }).x !== publicX) throw new Error('signing_key_invalid');
  const commandId = 'command_diagnostic_resume_' + digest(pauseId).slice(0, 24);
  const canonical = ['CITADEL-COMMAND-V1', commandId, nodeId, 'resume', digest('{}'), createdAt].join('\n');
  return { commandId, nodeId, pauseId, createdAt, signature: sign(null, Buffer.from(canonical), key).toString('base64url') };
}

export function resumeSql(command) {
  const c = Object.fromEntries(Object.entries(command).map(([key, value]) => [key, sqlString(value)]));
  // Repeat the eligibility and current-command checks atomically, so an owner
  // action between the read and insert wins. Keep the node's status unchanged
  // until the actual agent acknowledges the signed resume command.
  return `INSERT OR IGNORE INTO commands (command_id,node_id,command_type,payload_json,signature,status,created_at)
    SELECT ${c.commandId},n.node_id,'resume','{}',${c.signature},'pending',${c.createdAt}
    FROM nodes n JOIN commands p ON p.node_id=n.node_id
    WHERE n.node_id=${c.nodeId} AND n.status='paused' AND p.command_id=${c.pauseId}
      AND p.command_type='pause' AND p.status='completed'
      AND datetime(${c.createdAt}) < datetime('2026-10-09T00:00:00Z')
      AND datetime(p.created_at) BETWEEN datetime('2026-10-08T13:40:00Z') AND datetime('2026-10-08T13:46:00Z')
      AND NOT EXISTS (SELECT 1 FROM commands newer WHERE newer.node_id=n.node_id
        AND (datetime(newer.created_at)>datetime(p.created_at)
          OR (datetime(newer.created_at)=datetime(p.created_at) AND newer.rowid>p.rowid)))
      AND NOT EXISTS (SELECT 1 FROM commands active WHERE active.node_id=n.node_id AND active.status IN ('pending','accepted'));
    INSERT INTO audit_events (actor_type,actor_id,action,target_type,target_id,details_json)
    SELECT 'controller','diagnostic-pause-20261008','command.queued','command',${c.commandId},
      '{"command_type":"resume","reason":"end_diagnostic_pause"}'
    WHERE EXISTS (SELECT 1 FROM commands WHERE command_id=${c.commandId})
      AND NOT EXISTS (SELECT 1 FROM audit_events WHERE action='command.queued' AND target_id=${c.commandId});`;
}

function query(sql) {
  const env = { ...process.env };
  delete env.CONTROLLER_COMMAND_PRIVATE_JWK;
  const output = execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute',
    'citadel-control', '--remote', '--json', '--command', sql],
  { timeout: 45000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(output).flatMap(result => result.results || []);
}

async function main() {
  const rollout = query(`SELECT r.rollout_id,r.target_version,p.phase,p.pause_reason,p.canary_node_id,
    n.agent_version,n.status,n.last_seen_at FROM agent_rollouts r
    LEFT JOIN agent_rollout_policy p ON p.rollout_id=r.rollout_id
    LEFT JOIN nodes n ON n.node_id=p.canary_node_id
    ORDER BY datetime(r.created_at) DESC,r.rowid DESC LIMIT 1`)[0];
  if (rollout?.canary_node_id) {
    const nodeId = sqlString(rollout.canary_node_id);
    const update = query(`SELECT command_id,status,created_at,completed_at FROM commands
      WHERE node_id=${nodeId} AND command_type='update' ORDER BY datetime(created_at) DESC,rowid DESC LIMIT 1`)[0];
    const events = query(`SELECT event_type,created_at,details_json FROM node_logs WHERE node_id=${nodeId}
      ORDER BY datetime(created_at) DESC,event_id DESC LIMIT 100`);
    console.log(JSON.stringify({ test: 'bounded-canary-update-evidence', checked_at: new Date().toISOString(),
      target_version: rollout.target_version, phase: rollout.phase, pause_reason: rollout.pause_reason,
      agent_version: rollout.agent_version, node_status: rollout.status, last_seen_at: rollout.last_seen_at,
      update_status: update?.status || null, update_created_at: update?.created_at || null,
      ...summarizeFailure(events, update?.command_id) }));
  }
  const expectedHash = process.env.CITADEL_DIAGNOSTIC_RESUME_NODE_HASH;
  if (!expectedHash || Date.now() >= Date.parse('2026-10-09T00:00:00Z')) return;
  const paused = query("SELECT node_id,status FROM nodes WHERE status='paused' LIMIT 100");
  const node = paused.find(item => digest(item.node_id) === expectedHash);
  if (!node) { console.log('{"diagnostic_pause_resume":"not_needed"}'); return; }
  const latest = query(`SELECT command_id,command_type,status,created_at FROM commands WHERE node_id=${sqlString(node.node_id)}
    ORDER BY datetime(created_at) DESC,rowid DESC LIMIT 1`)[0];
  if (!eligibleDiagnosticPause(node, latest, expectedHash)) {
    console.log('{"diagnostic_pause_resume":"owner_state_preserved"}'); return;
  }
  const resume = signedResume(node.node_id, latest.command_id, process.env.CONTROLLER_COMMAND_PRIVATE_JWK, new Date().toISOString());
  query(resumeSql(resume));
  const deadline = Date.now() + 180000;
  let status = 'not_queued';
  do {
    status = query(`SELECT status FROM commands WHERE command_id=${sqlString(resume.commandId)}`)[0]?.status || 'not_queued';
    if (!['pending', 'accepted'].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 10000));
  } while (Date.now() < deadline);
  console.log(JSON.stringify({ diagnostic_pause_resume: status }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Bounded rollout evidence or diagnostic resume failed; private details withheld.'); process.exitCode = 1; });
}
