let telemetrySchemaPromise;

export async function ensureTelemetryStorage(env) {
  if (!telemetrySchemaPromise) {
    telemetrySchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS node_logs (
          event_id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL,
          level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
          event_type TEXT NOT NULL,
          message TEXT NOT NULL,
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_logs_node_created
        ON node_logs(node_id, created_at DESC, event_id DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_logs_received
        ON node_logs(received_at DESC)
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_logs_level_created
        ON node_logs(level, created_at DESC)
      `)
    ]).catch((error) => {
      telemetrySchemaPromise = undefined;
      throw error;
    });
  }
  await telemetrySchemaPromise;
}
