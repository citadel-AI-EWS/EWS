-- Group labels for the Hub. Existing nodes and group memberships are preserved.
CREATE TABLE IF NOT EXISTS node_group_categories (
  group_id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('name','geography','work','specialty','other')),
  FOREIGN KEY (group_id) REFERENCES enterprise_node_groups(group_id) ON DELETE CASCADE
);
