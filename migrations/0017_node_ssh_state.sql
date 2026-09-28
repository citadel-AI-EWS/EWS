-- SSH readiness only. No SSH private keys, passwords, Access tokens, or session secrets are stored in D1.
CREATE TABLE IF NOT EXISTS node_ssh_state (
  node_id TEXT PRIMARY KEY,
  ssh_server_installed INTEGER NOT NULL DEFAULT 0 CHECK (ssh_server_installed IN (0,1)),
  ssh_server_running INTEGER NOT NULL DEFAULT 0 CHECK (ssh_server_running IN (0,1)),
  local_port_open INTEGER NOT NULL DEFAULT 0 CHECK (local_port_open IN (0,1)),
  cloudflared_installed INTEGER NOT NULL DEFAULT 0 CHECK (cloudflared_installed IN (0,1)),
  cloudflared_running INTEGER NOT NULL DEFAULT 0 CHECK (cloudflared_running IN (0,1)),
  tunnel_configured INTEGER NOT NULL DEFAULT 0 CHECK (tunnel_configured IN (0,1)),
  access_hostname TEXT,
  access_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (access_mode IN ('none','browser','infrastructure')),
  checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_node_ssh_state_updated
  ON node_ssh_state(updated_at DESC);
