const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

const MAX_BODY_BYTES = 8 * 1024;
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 24 * 60;

const DEPLOYMENT_RELEASE = Object.freeze({
  version: "0.3.15",
  platform: "windows-x64",
  format: "zip",
  artifact_url:
    "https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/releases/CITADEL_FIXED_AGENT_0.3.15_2026-09-21.zip",
  sha256: "315212c211436e1489b1349ecadd1f1c433318b9a5658a08c781bd19b46939cc",
  install_entrypoint: "setup_windows.ps1"
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  let diff = 0;
  for (let i = 0; i < 64; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function randomToken(prefix) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return prefix + encoded;
}

function normalizeLabel(value) {
  if (typeof value !== "string") throw new Error("invalid_label");
  const label = value.trim();
  if (!label || label.length > 120) throw new Error("invalid_label");
  return label;
}

function normalizeTtlMinutes(value) {
  const parsed = value === undefined ? 60 : Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_TTL_MINUTES ||
    parsed > MAX_TTL_MINUTES
  ) {
    throw new Error("invalid_ttl_minutes");
  }
  return parsed;
}

async function readJson(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error("request_too_large");
  }
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("json_object_required");
  }
  return body;
}

async function authenticateDeploymentOwner(request, env) {
  const expected = String(env.ARCHITECT_TOKEN_HASH || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    return { ok: false, response: json({ ok: false, error: "architect_auth_not_configured" }, 503) };
  }

  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || "";
  if (!token || token.length > 512) {
    return { ok: false, response: json({ ok: false, error: "architect_authentication_required" }, 401) };
  }

  const actual = await sha256Hex(token);
  if (!constantTimeHexEqual(actual, expected)) {
    return { ok: false, response: json({ ok: false, error: "invalid_architect_token" }, 401) };
  }
  return { ok: true, actor: "primary" };
}

export async function ensureDeploymentStorage(env) {
  await env.DB.batch([
    env.DB.prepare(`
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
      )
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_deployment_invites_status_expiry
      ON deployment_invites(status, expires_at)
    `)
  ]);
}

function releaseManifest(controllerUrl) {
  return {
    schema: "citadel.deployment.manifest.v1",
    controller_url: controllerUrl,
    release: DEPLOYMENT_RELEASE,
    safety: {
      target_initiated: true,
      requires_local_admin_approval: true,
      autonomous_network_discovery: false,
      lateral_movement: false,
      credential_collection: false
    }
  };
}

export function deploymentReleaseManifest(controllerUrl = "https://citadel-ai.init1.workers.dev") {
  return releaseManifest(controllerUrl);
}

async function createInvite(request, env) {
  const auth = await authenticateDeploymentOwner(request, env);
  if (!auth.ok) return auth.response;
  await ensureDeploymentStorage(env);

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const code = String(error.message || error);
    return json({ ok: false, error: code }, code === "request_too_large" ? 413 : 400);
  }

  let label;
  let ttlMinutes;
  try {
    label = normalizeLabel(body.label || "Authorized Windows node");
    ttlMinutes = normalizeTtlMinutes(body.ttl_minutes);
  } catch (error) {
    return json({ ok: false, error: String(error.message || error) }, 400);
  }

  const inviteId = `deploy_${crypto.randomUUID()}`;
  const rawToken = randomToken("citadel_deploy_");
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO deployment_invites (
      invite_id, token_hash, label, target_os, expires_at, created_by
    ) VALUES (?, ?, ?, 'windows', ?, ?)
  `).bind(inviteId, tokenHash, label, expiresAt, auth.actor).run();

  await env.DB.prepare(`
    INSERT INTO audit_events (
      actor_type, actor_id, action, target_type, target_id, details_json
    ) VALUES ('architect', ?, 'deployment.invite.created',
      'deployment_invite', ?, ?)
  `).bind(
    auth.actor,
    inviteId,
    JSON.stringify({ label, target_os: "windows", expires_at: expiresAt, max_uses: 1 })
  ).run();

  return json({
    ok: true,
    invite: {
      invite_id: inviteId,
      label,
      target_os: "windows",
      status: "active",
      expires_at: expiresAt,
      max_uses: 1
    },
    token: rawToken,
    token_notice: "Shown once. Store only long enough to install the authorized host.",
    bootstrap_path: "agent/install_from_invite.ps1"
  }, 201);
}

async function listInvites(request, env) {
  const auth = await authenticateDeploymentOwner(request, env);
  if (!auth.ok) return auth.response;
  await ensureDeploymentStorage(env);

  await env.DB.prepare(`
    UPDATE deployment_invites
    SET status = 'expired'
    WHERE status = 'active' AND datetime(expires_at) <= CURRENT_TIMESTAMP
  `).run();

  const result = await env.DB.prepare(`
    SELECT invite_id, label, target_os, status, expires_at,
      use_count, max_uses, created_by, created_at, last_redeemed_at
    FROM deployment_invites
    ORDER BY created_at DESC
    LIMIT 100
  `).all();
  return json({ ok: true, invites: result.results || [] });
}

async function revokeInvite(request, env, inviteId) {
  const auth = await authenticateDeploymentOwner(request, env);
  if (!auth.ok) return auth.response;
  await ensureDeploymentStorage(env);

  const result = await env.DB.prepare(`
    UPDATE deployment_invites
    SET status = 'revoked'
    WHERE invite_id = ? AND status = 'active'
  `).bind(inviteId).run();

  if ((result?.meta?.changes || 0) !== 1) {
    return json({ ok: false, error: "invite_not_active" }, 409);
  }

  await env.DB.prepare(`
    INSERT INTO audit_events (
      actor_type, actor_id, action, target_type, target_id, details_json
    ) VALUES ('architect', ?, 'deployment.invite.revoked',
      'deployment_invite', ?, '{}')
  `).bind(auth.actor, inviteId).run();

  return json({ ok: true, invite_id: inviteId, status: "revoked" });
}

async function redeemInvite(request, env) {
  await ensureDeploymentStorage(env);
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const code = String(error.message || error);
    return json({ ok: false, error: code }, code === "request_too_large" ? 413 : 400);
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const hostname = typeof body.hostname === "string" ? body.hostname.trim().slice(0, 255) : "";
  const osName = typeof body.os_name === "string" ? body.os_name.trim().slice(0, 80) : "";
  const architecture = typeof body.architecture === "string"
    ? body.architecture.trim().slice(0, 80)
    : "";

  if (!/^citadel_deploy_[A-Za-z0-9_-]{32,}$/.test(token)) {
    return json({ ok: false, error: "invalid_deployment_token" }, 401);
  }
  if (!hostname || !/^windows/i.test(osName)) {
    return json({ ok: false, error: "unsupported_or_invalid_target" }, 400);
  }

  const tokenHash = await sha256Hex(token);
  const claimed = await env.DB.prepare(`
    UPDATE deployment_invites
    SET use_count = use_count + 1,
        status = 'consumed',
        last_redeemed_at = CURRENT_TIMESTAMP
    WHERE token_hash = ?
      AND status = 'active'
      AND use_count < max_uses
      AND datetime(expires_at) > CURRENT_TIMESTAMP
    RETURNING invite_id, label, expires_at
  `).bind(tokenHash).first();

  if (!claimed) {
    return json({ ok: false, error: "deployment_token_expired_used_or_revoked" }, 401);
  }

  const controllerUrl = new URL(request.url).origin;
  await env.DB.prepare(`
    INSERT INTO audit_events (
      actor_type, actor_id, action, target_type, target_id, details_json
    ) VALUES ('installer', ?, 'deployment.invite.redeemed',
      'deployment_invite', ?, ?)
  `).bind(
    hostname,
    claimed.invite_id,
    JSON.stringify({
      hostname,
      os_name: osName,
      architecture,
      release_version: DEPLOYMENT_RELEASE.version
    })
  ).run();

  return json({
    ok: true,
    invite: {
      invite_id: claimed.invite_id,
      label: claimed.label,
      status: "consumed",
      expires_at: claimed.expires_at
    },
    manifest: releaseManifest(controllerUrl)
  });
}

export function isDeploymentPath(pathname) {
  return pathname === "/api/v1/architect/deployments" ||
    pathname === "/api/v1/deployments/redeem" ||
    /^\/api\/v1\/architect\/deployments\/[^/]+\/revoke$/.test(pathname);
}

export async function handleDeploymentRequest(request, env, url = new URL(request.url)) {
  if (url.pathname === "/api/v1/architect/deployments") {
    if (request.method === "POST") return createInvite(request, env);
    if (request.method === "GET") return listInvites(request, env);
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  if (url.pathname === "/api/v1/deployments/redeem") {
    return request.method === "POST"
      ? redeemInvite(request, env)
      : json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const revoke = url.pathname.match(
    /^\/api\/v1\/architect\/deployments\/([^/]+)\/revoke$/
  );
  if (revoke) {
    return request.method === "POST"
      ? revokeInvite(request, env, decodeURIComponent(revoke[1]))
      : json({ ok: false, error: "method_not_allowed" }, 405);
  }

  return json({ ok: false, error: "not_found" }, 404);
}
