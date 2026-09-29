-- Remove only routine machine-status history; preserve task reports and security audit.
DELETE FROM audit_events WHERE action = 'node.heartbeat';
DELETE FROM node_logs WHERE level != 'error' AND event_type IN (
  'agent_start','agent_stop','windows_sleep_inhibit','windows_sleep_hibernate_inhibit',
  'resource_guard','result_queued','queued_results_flushed',
  'agent_update_healthcheck_passed','network_recovery_attempted'
);
