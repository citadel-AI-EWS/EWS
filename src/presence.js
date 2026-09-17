import {
  TelemetryError,
  authenticateArchitect,
  json,
  methodNotAllowed
} from "./telemetry/common.js";

let presenceSchemaPromise;

export async function ensurePresenceStorage(env) {
  if (!presenceSchemaPromise) {
    presenceSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS node_presence (
          node_id TEXT PRIMARY KEY,
          public_ip TEXT,
          country TEXT,
          colo TEXT,
          asn INTEGER,
          first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_node_presence_updated
        ON node_presence(updated_at DESC)
      `)
    ]).catch((error) => {
      presenceSchemaPromise = undefined;
      throw error;
    });
  }
  await presenceSchemaPromise;
}

function normalizedIp(request) {
  const value = (request.headers.get("cf-connecting-ip") || "").trim();
  if (!value || value.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(value)) return null;
  return value;
}

function normalizedCfText(value, maxLength) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

export async function recordNodePresence(request, env, nodeId) {
  const publicIp = normalizedIp(request);
  if (!publicIp) return;

  await ensurePresenceStorage(env);
  const cf = request.cf || {};
  const country = normalizedCfText(cf.country, 8);
  const colo = normalizedCfText(cf.colo, 16);
  const asn = Number.isInteger(cf.asn) && cf.asn >= 0 ? cf.asn : null;

  await env.DB.prepare(`
    INSERT INTO node_presence (
      node_id, public_ip, country, colo, asn, first_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(node_id) DO UPDATE SET
      public_ip = excluded.public_ip,
      country = excluded.country,
      colo = excluded.colo,
      asn = excluded.asn,
      updated_at = CURRENT_TIMESTAMP
  `).bind(nodeId, publicIp, country, colo, asn).run();
}

async function architectPresence(request, env) {
  await authenticateArchitect(request, env);
  await ensurePresenceStorage(env);
  const query = await env.DB.prepare(`
    SELECT p.node_id, p.public_ip, p.country, p.colo, p.asn,
           p.first_seen_at, p.updated_at
    FROM node_presence AS p
    JOIN nodes AS n ON n.node_id = p.node_id
    WHERE n.status != 'revoked'
    ORDER BY p.updated_at DESC
    LIMIT 500
  `).all();
  return json({ ok: true, presence: query.results || [] });
}

export function isPresencePath(pathname) {
  return pathname === "/api/v1/architect/presence";
}

export async function handlePresenceRequest(request, env) {
  try {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return await architectPresence(request, env);
  } catch (error) {
    if (error instanceof TelemetryError) {
      return json({ ok: false, error: error.code }, error.status, error.headers);
    }
    console.error("Unhandled presence API error", error);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}
