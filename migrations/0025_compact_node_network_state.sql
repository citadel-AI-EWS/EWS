-- Compact per-node network state: keep only LAN identity required by CITADEL.
-- Rebuild is idempotent in the ordered migration chain and preserves existing LAN/MAC data.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS node_network_state_compact (
  node_id TEXT PRIMARY KEY,
  lan_ipv4 TEXT,
  mac_addresses_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

INSERT OR REPLACE INTO node_network_state_compact (
  node_id, lan_ipv4, mac_addresses_json, updated_at
)
SELECT node_id, lan_ipv4, mac_addresses_json, updated_at
FROM node_network_state;

DROP TABLE node_network_state;

ALTER TABLE node_network_state_compact RENAME TO node_network_state;

CREATE INDEX IF NOT EXISTS idx_node_network_lan
  ON node_network_state(lan_ipv4, updated_at DESC);
