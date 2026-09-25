-- Compact legacy heartbeat monitoring rows.
-- Heartbeats now update the current node/network state in place instead of
-- appending one audit_events row every interval. Keep audit_events for actions
-- and state-changing operations, not routine liveness sampling.

DELETE FROM audit_events
WHERE action = 'node.heartbeat';
