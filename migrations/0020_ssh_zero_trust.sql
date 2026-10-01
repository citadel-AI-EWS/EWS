-- Per-node SSH Zero Trust readiness and public browser-access configuration.
-- No private keys, passwords, tokens, or CA private material are stored here.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS node_ssh_state (
  node_id TEXT PRIMARY KEY,
  ssh_client_available INTEGER NOT NULL DEFAULT 0 CHECK (ssh_client_available IN (0,1)),
  sshd_process_running INTEGER NOT NULL DEFAULT 0 CHECK (sshd_process_running IN (0,1)),
  sshd_listening_local INTEGER NOT NULL DEFAULT 0 CHECK (sshd_listening_local IN (0,1)),
  sshd_exposure_verified INTEGER NOT NULL DEFAULT 0 CHECK (sshd_exposure_verified IN (0,1)),
  sshd_loopback_only INTEGER NOT NULL DEFAULT 0 CHECK (sshd_loopback_only IN (0,1)),
  cloudflared_installed INTEGER NOT NULL DEFAULT 0 CHECK (cloudflared_installed IN (0,1)),
  cloudflared_running INTEGER NOT NULL DEFAULT 0 CHECK (cloudflared_running IN (0,1)),
  browser_terminal_local_ready INTEGER NOT NULL DEFAULT 0 CHECK (browser_terminal_local_ready IN (0,1)),
  bind_target TEXT NOT NULL DEFAULT 'localhost:22',
  public_hostname TEXT,
  ssh_user TEXT,
  host_key_fingerprint TEXT,
  config_updated_at TEXT,
  observed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_node_ssh_ready
ON node_ssh_state(browser_terminal_local_ready, updated_at DESC);
