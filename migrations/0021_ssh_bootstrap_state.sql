-- Extend SSH readiness with proof that the origin is locked to CITADEL's
-- restricted ForceCommand and has forwarding disabled.
ALTER TABLE node_ssh_state
  ADD COLUMN restricted_force_command INTEGER NOT NULL DEFAULT 0
  CHECK (restricted_force_command IN (0,1));

ALTER TABLE node_ssh_state
  ADD COLUMN forwarding_disabled INTEGER NOT NULL DEFAULT 0
  CHECK (forwarding_disabled IN (0,1));

ALTER TABLE node_ssh_state
  ADD COLUMN managed_username TEXT;
