-- Real node network identity used for operational diagnostics and Wake-on-LAN.
-- MAC addresses are reported by the authenticated node itself and are never exposed publicly.

CREATE TABLE IF NOT EXISTS node_network_state (
  node_id TEXT PRIMARY KEY,
  lan_ipv4 TEXT,
  tailscale_ipv4 TEXT,
  mac_addresses_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_node_network_lan
  ON node_network_state(lan_ipv4, updated_at DESC);
