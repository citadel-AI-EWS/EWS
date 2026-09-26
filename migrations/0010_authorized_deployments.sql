CREATE TABLE IF NOT EXISTS deployment_invites (
  invite_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  target_os TEXT NOT NULL DEFAULT 'windows'
    CHECK (target_os IN ('windows')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','consumed','revoked','expired')),
  expires_at TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses = 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_redeemed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_deployment_invites_status_expiry
ON deployment_invites(status, expires_at);
