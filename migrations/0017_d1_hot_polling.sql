-- Bound rows-read for fleet/control lookups used by Operations and Hub.
-- Status-first command access avoids walking unrelated command history for
-- pending/accepted and recent-command snapshots.
CREATE INDEX IF NOT EXISTS idx_commands_status_created
  ON commands(status, created_at DESC, command_id DESC);

-- Architect overview checks whether a command has an expiry audit record.
-- Keep that point lookup bounded as audit history grows.
CREATE INDEX IF NOT EXISTS idx_audit_events_target_action
  ON audit_events(target_type, target_id, action, event_id DESC);
