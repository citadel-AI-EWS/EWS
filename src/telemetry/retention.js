// Routine status belongs in the replaceable node snapshot, not the event history.
const retained = new Set([
  'result_submitted', 'command_completed', 'agent_updated',
  'agent_update_rolled_back', 'agent_update_manual_rollback',
  'hybrid_query_completed', 'command_signature_rejected',
  'assignment_rejected_local', 'command_failed'
]);
export function keepOperationalEvent(event) {
  return event.level === 'error' || retained.has(event.event_type);
}
