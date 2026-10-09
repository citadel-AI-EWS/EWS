// Continue this session's already requested Update All with its repaired release.
// No command is sent before a real, alternative canary returns online.
export function patchedRolloutEligible(rollout, release, now = Date.now()) {
  return now < Date.parse('2026-10-15T00:00:00Z') &&
    ((rollout?.target_version === '0.3.40' && release?.version === '0.3.41') ||
      (['0.3.40','0.3.41'].includes(rollout?.target_version) && release?.version === '0.3.42') ||
      (rollout?.target_version === '0.3.42' && release?.version === '0.3.43'));
}

export const RETIRE_PATCHED_ROLLOUT_SQL = `UPDATE agent_rollouts SET status='completed',updated_at=?
  WHERE rollout_id=? AND status='active' AND target_version=? AND created_at=?
    AND datetime(?) < datetime('2026-10-15T00:00:00Z')
    AND EXISTS (SELECT 1 FROM audit_events a WHERE a.target_id=agent_rollouts.rollout_id
      AND a.action='agent.rollout.started' AND a.actor_type='architect')
    AND EXISTS (SELECT 1 FROM agent_rollout_policy p WHERE p.rollout_id=agent_rollouts.rollout_id
      AND p.phase='paused' AND p.pause_reason IN ('canary_command_failed','canary_update_timeout',
        'canary_heartbeat_timeout','fleet_failure_budget_exceeded')
      AND (p.pause_reason='fleet_failure_budget_exceeded' OR p.canary_node_id<>?))
    AND EXISTS (SELECT 1 FROM nodes n WHERE n.node_id=? AND n.status='online'
      AND datetime(n.last_seen_at)>=datetime(?,'-5 minutes'))
    AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.node_id=?
      AND c.status IN ('pending','accepted') AND datetime(c.created_at)>=datetime(?,'-15 minutes'))
    AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.command_type='update'
      AND c.status IN ('pending','accepted') AND datetime(c.created_at)>=datetime(agent_rollouts.created_at))`;

export async function recoverPatchedRollout(env, rollout, release, nodeId, eligibleCanary, now = Date.now(), expireCommands = null) {
  if (!patchedRolloutEligible(rollout, release, now)) return rollout;
  const policy = await env.DB.prepare('SELECT phase,pause_reason,canary_node_id,max_parallel,max_failures FROM agent_rollout_policy WHERE rollout_id=?')
    .bind(rollout.rollout_id).first();
  if (policy?.phase !== 'paused' || !['canary_command_failed','canary_update_timeout',
    'canary_heartbeat_timeout','fleet_failure_budget_exceeded'].includes(policy.pause_reason)) return rollout;
  const node = await env.DB.prepare('SELECT node_id,hostname,status,agent_version,last_seen_at FROM nodes WHERE node_id=?')
    .bind(nodeId).first();
  if (!eligibleCanary(node, policy) || node.agent_version === release.version) return rollout;
  // Use the normal expiry/audit path first. Every remaining update from the
  // old rollout must finish before its replacement can consume fleet slots.
  if (expireCommands) await expireCommands(env);
  const createdAt = new Date(now).toISOString();
  const rolloutId = 'rollout_' + crypto.randomUUID();
  const result = await env.DB.batch([
    env.DB.prepare(RETIRE_PATCHED_ROLLOUT_SQL).bind(createdAt,rollout.rollout_id,rollout.target_version,rollout.created_at,
      createdAt,nodeId,nodeId,createdAt,nodeId,createdAt),
    env.DB.prepare(`INSERT INTO agent_rollouts(rollout_id,target_version,release_json,status,created_at,updated_at)
      SELECT ?,?,?, 'active',?,? WHERE changes()=1`)
      .bind(rolloutId,release.version,JSON.stringify(release),createdAt,createdAt),
    env.DB.prepare(`INSERT INTO agent_rollout_policy(rollout_id,canary_node_id,phase,max_parallel,max_failures)
      SELECT ?,?,'canary',?,? WHERE changes()=1`)
      .bind(rolloutId,nodeId,policy.max_parallel,policy.max_failures),
    env.DB.prepare(`INSERT INTO audit_events(actor_type,actor_id,action,target_type,target_id,details_json)
      SELECT 'controller','authorized-rollout-repair-20261009','agent.rollout.patched_release_started','rollout',?,?
      WHERE changes()=1`).bind(rolloutId,JSON.stringify({previous_rollout_id:rollout.rollout_id,
        target_version:release.version,canary_node_id:nodeId}))
  ]);
  return Number(result[1]?.meta?.changes || 0) === 1
    ? {rollout_id:rolloutId,target_version:release.version,release_json:JSON.stringify(release),created_at:createdAt}
    : rollout;
}
