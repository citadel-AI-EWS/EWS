// Close only this repair session's diagnostic hold after an offline period.
// A later owner command always wins. Normal command TTLs remain unchanged.
export const DIAGNOSTIC_NODE_HASH = '45cb5f42434ef6c0c4fdbdde894b57a72b39ea73b1cc4402d16b09742ee15bb9';
export const DIAGNOSTIC_RECOVERY_END = '2026-10-15T00:00:00Z';

export function expiredDiagnosticResumeEligible(node, command, now = Date.now()) {
  return now < Date.parse(DIAGNOSTIC_RECOVERY_END) && node?.status === 'paused' &&
    command?.command_type === 'resume' && command.status === 'failed' &&
    command.owned_resume === 1 && command.expired_pending === 1 &&
    /^command_diagnostic_resume_[a-f0-9]{24}$/.test(command.command_id || '');
}

export const DIAGNOSTIC_RESUME_REQUEUE_SQL = `UPDATE commands SET signature=?,created_at=?,status='pending',completed_at=NULL
  WHERE command_id=? AND node_id=? AND created_at=? AND status='failed' AND command_type='resume'
    AND datetime(?) < datetime('2026-10-15T00:00:00Z')
    AND EXISTS (SELECT 1 FROM nodes n WHERE n.node_id=commands.node_id AND n.status='paused')
    AND EXISTS (SELECT 1 FROM commands p WHERE p.command_id=? AND p.node_id=commands.node_id
      AND p.command_type='pause' AND p.status='completed'
      AND datetime(p.created_at) BETWEEN datetime('2026-10-08T13:40:00Z') AND datetime('2026-10-08T13:46:00Z'))
    AND EXISTS (SELECT 1 FROM audit_events a WHERE a.target_id=commands.command_id AND a.action='command.queued'
      AND a.actor_type='controller' AND a.actor_id='diagnostic-pause-20261008')
    AND EXISTS (SELECT 1 FROM audit_events a WHERE a.target_id=commands.command_id AND a.action='command.expired'
      AND json_extract(a.details_json,'$.previous_status')='pending'
      AND json_extract(a.details_json,'$.created_at')=commands.created_at)
    AND NOT EXISTS (SELECT 1 FROM commands newer WHERE newer.node_id=commands.node_id
      AND (datetime(newer.created_at)>datetime(commands.created_at)
        OR (datetime(newer.created_at)=datetime(commands.created_at) AND newer.rowid>commands.rowid)))`;
