#!/usr/bin/env node
import fs from "node:fs";

const API = "https://api.cloudflare.com/client/v4";

function fail(message) {
  throw new Error(message);
}

function normalizeHostname(value) {
  const host = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    fail("invalid_public_hostname");
  }
  return host;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail("invalid_allowed_email");
  return email;
}

function normalizeTunnelName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) fail("invalid_tunnel_name");
  if (!name.toLowerCase().startsWith("citadel-ssh-")) fail("tunnel_name_must_use_citadel_ssh_prefix");
  return name;
}

function normalizeSession(value) {
  const session = String(value || "1h").trim();
  if (!new Set(["30m", "1h", "2h", "4h"]).has(session)) fail("invalid_session_duration");
  return session;
}

function sshUserFromEmail(email) {
  const prefix = email.split("@", 1)[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(prefix)) {
    fail("email_prefix_is_not_a_valid_windows_ssh_username");
  }
  return prefix;
}

function readAccountId() {
  const explicit = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  if (/^[a-f0-9]{32}$/i.test(explicit)) return explicit;
  const config = fs.readFileSync("wrangler.jsonc", "utf8");
  const match = config.match(/"D1_ANALYTICS_ACCOUNT_ID"\s*:\s*"([a-f0-9]{32})"/i);
  if (!match) fail("cloudflare_account_id_missing");
  return match[1];
}

function token() {
  const value = String(
    process.env.FULL_CLOUDFLARE_CONTROL ||
    process.env.CLOUDFLARE_API_TOKEN ||
    ""
  ).trim();
  if (!value) fail("cloudflare_api_token_missing");
  return value;
}

async function cf(path, options = {}, allowedStatuses = []) {
  const headers = {
    authorization: `Bearer ${token()}`,
    accept: "application/json",
    ...(options.body ? {"content-type": "application/json"} : {}),
    ...(options.headers || {})
  };
  const response = await fetch(API + path, {...options, headers});
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    const errors = Array.isArray(body?.errors) ? body.errors.map(x => x?.message).filter(Boolean) : [];
    fail(`cloudflare_http_${response.status}: ${errors.join("; ") || "request_failed"}`);
  }
  if (response.ok && body?.success !== true) {
    const errors = Array.isArray(body?.errors) ? body.errors.map(x => x?.message).filter(Boolean) : [];
    fail(`cloudflare_api_failed: ${errors.join("; ") || "success_false"}`);
  }
  return {status: response.status, body};
}

async function listAll(path) {
  const results = [];
  for (let page = 1; page <= 50; page += 1) {
    const join = path.includes("?") ? "&" : "?";
    const {body} = await cf(`${path}${join}per_page=100&page=${page}`);
    const batch = Array.isArray(body?.result) ? body.result : [];
    results.push(...batch);
    const totalPages = Number(body?.result_info?.total_pages || 1);
    if (page >= totalPages || batch.length === 0) return results;
  }
  fail("cloudflare_pagination_limit_exceeded");
}

async function findZone(hostname, accountId) {
  const zones = await listAll(`/zones?status=active&account.id=${encodeURIComponent(accountId)}`);
  const candidates = zones.filter(z => {
    const name = String(z?.name || "").toLowerCase();
    return name && (hostname === name || hostname.endsWith("." + name));
  }).sort((a, b) => String(b.name).length - String(a.name).length);
  if (!candidates.length) fail("no_active_cloudflare_zone_matches_hostname");
  return candidates[0];
}

async function ensureTunnel(accountId, tunnelName, apply) {
  const tunnels = await listAll(`/accounts/${accountId}/cfd_tunnel?is_deleted=false`);
  const exact = tunnels.filter(t => t?.name === tunnelName);
  if (exact.length > 1) fail("duplicate_tunnel_name");
  if (exact.length === 1) {
    const existing = exact[0];
    if (String(existing?.config_src || "") !== "cloudflare") {
      fail("existing_tunnel_is_not_remotely_managed");
    }
    return {tunnel: existing, created: false};
  }
  if (!apply) return {tunnel: {id: "<planned>", name: tunnelName, config_src: "cloudflare"}, created: true};
  const {body} = await cf(`/accounts/${accountId}/cfd_tunnel`, {
    method: "POST",
    body: JSON.stringify({name: tunnelName, config_src: "cloudflare"})
  });
  if (!body?.result?.id) fail("created_tunnel_missing_id");
  return {tunnel: body.result, created: true};
}

async function ensureTunnelIngress(accountId, tunnelId, hostname, apply) {
  let baseConfig = {};
  let ingress = [];
  if (tunnelId !== "<planned>") {
    const current = await cf(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {}, [404]);
    const rawConfig = current.body?.result?.config;
    baseConfig = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
    ingress = Array.isArray(baseConfig.ingress) ? baseConfig.ingress : [];
  }

  const foreignRoutes = ingress.filter(item => item && item.hostname && item.hostname !== hostname);
  if (foreignRoutes.length) fail("existing_tunnel_contains_unmanaged_hostname_routes");

  const targetRoutes = ingress.filter(item => item && item.hostname === hostname);
  if (targetRoutes.length > 1) fail("existing_tunnel_contains_duplicate_ssh_routes");
  if (targetRoutes.some(item => item.path)) fail("existing_tunnel_contains_path_scoped_ssh_route");

  const catchAllRoutes = ingress.filter(item => item && !item.hostname);
  if (catchAllRoutes.length > 1) fail("existing_tunnel_contains_multiple_catch_all_routes");
  if (catchAllRoutes.length === 1 && catchAllRoutes[0].service !== "http_status:404") {
    fail("existing_tunnel_contains_unmanaged_catch_all_route");
  }

  const routes = [
    {hostname, service: "ssh://localhost:22"},
    catchAllRoutes[0] || {service: "http_status:404"}
  ];
  if (apply && tunnelId !== "<planned>") {
    await cf(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({config: {...baseConfig, ingress: routes}})
    });
  }
  return routes;
}

async function ensureDns(zoneId, hostname, tunnelId, apply) {
  const records = await listAll(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
  if (records.length > 1) fail("multiple_dns_records_for_ssh_hostname");
  if (tunnelId === "<planned>") {
    if (records.length === 1) fail("ssh_hostname_dns_record_conflicts_with_existing_record");
    return {id: "<planned>", type: "CNAME", name: hostname, content: "<tunnel-id>.cfargotunnel.com", proxied: true};
  }
  const desired = `${tunnelId}.cfargotunnel.com`;
  if (records.length === 1) {
    const record = records[0];
    if (record.type !== "CNAME" || String(record.content).toLowerCase() !== desired.toLowerCase() || record.proxied !== true) {
      fail("ssh_hostname_dns_record_conflicts_with_existing_record");
    }
    return record;
  }
  if (!apply) return {id: "<planned>", type: "CNAME", name: hostname, content: desired, proxied: true};
  const {body} = await cf(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({type: "CNAME", name: hostname, content: desired, proxied: true, ttl: 1})
  });
  return body.result;
}

async function ensureAccessApp(accountId, hostname, nodeLabel, sessionDuration, apply) {
  const desired = {
    name: `CITADEL SSH ${nodeLabel}`,
    domain: hostname,
    type: "ssh",
    session_duration: sessionDuration,
    app_launcher_visible: false
  };
  const apps = await listAll(`/accounts/${accountId}/access/apps`);
  const matches = apps.filter(app => String(app?.domain || "").toLowerCase() === hostname);
  if (matches.length > 1) fail("multiple_access_apps_for_ssh_hostname");
  if (matches.length === 1) {
    const existing = matches[0];
    if (existing.type !== "ssh") fail("existing_access_app_for_hostname_is_not_browser_ssh");
    if (!String(existing.name || "").startsWith("CITADEL SSH ")) {
      fail("existing_access_app_for_hostname_is_not_owned_by_citadel");
    }
    const durationMismatch = String(existing.session_duration || "") !== sessionDuration;
    if (!durationMismatch || !apply) {
      return {app: existing, created: false, updated: false, update_required: durationMismatch};
    }
    const {body} = await cf(`/accounts/${accountId}/access/apps/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(desired)
    });
    if (!body?.result?.id) fail("updated_access_app_missing_id");
    return {app: body.result, created: false, updated: true, update_required: false};
  }
  if (!apply) return {app: {id: "<planned>", ...desired}, created: true, updated: false, update_required: false};
  const {body} = await cf(`/accounts/${accountId}/access/apps`, {
    method: "POST",
    body: JSON.stringify(desired)
  });
  if (!body?.result?.id) fail("created_access_app_missing_id");
  return {app: body.result, created: true, updated: false, update_required: false};
}

function desiredPolicy(hostname, email) {
  return {
    name: `CITADEL SSH allow ${hostname}`,
    decision: "allow",
    include: [{email: {email}}],
    exclude: [],
    require: []
  };
}

async function ensurePolicy(accountId, appId, hostname, email, apply) {
  const wanted = desiredPolicy(hostname, email);
  if (appId === "<planned>") {
    return {policy: {id: "<planned>", ...wanted}, created: true, updated: false, update_required: false};
  }
  const policies = await listAll(`/accounts/${accountId}/access/apps/${appId}/policies`);
  const incompatible = policies.filter(p => !["allow", "deny"].includes(String(p?.decision || "")));
  if (incompatible.length) fail("browser_ssh_app_contains_unsupported_bypass_or_service_auth_policy");
  const unexpected = policies.filter(p => p?.name !== wanted.name);
  if (unexpected.length) fail("browser_ssh_app_contains_additional_policy");
  const matching = policies.filter(p => p?.name === wanted.name);
  if (matching.length > 1) fail("duplicate_citadel_ssh_policy");
  const existing = matching[0];
  if (existing && existing.decision !== "allow") fail("citadel_ssh_policy_has_wrong_decision");

  const include = Array.isArray(existing?.include) ? existing.include : [];
  const exclude = Array.isArray(existing?.exclude) ? existing.exclude : [];
  const requireRules = Array.isArray(existing?.require) ? existing.require : [];
  const exactEmail = include.length === 1 &&
    String(include[0]?.email?.email || "").trim().toLowerCase() === email;
  const updateRequired = Boolean(existing) && !(exactEmail && exclude.length === 0 && requireRules.length === 0);

  if (existing && (!updateRequired || !apply)) {
    return {policy: existing, created: false, updated: false, update_required: updateRequired};
  }
  if (!existing && !apply) {
    return {policy: {id: "<planned>", ...wanted}, created: true, updated: false, update_required: false};
  }
  if (existing?.id) {
    const {body} = await cf(`/accounts/${accountId}/access/apps/${appId}/policies/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(wanted)
    });
    if (!body?.result?.id) fail("updated_access_policy_missing_id");
    return {policy: body.result, created: false, updated: true, update_required: false};
  }
  const {body} = await cf(`/accounts/${accountId}/access/apps/${appId}/policies`, {
    method: "POST",
    body: JSON.stringify(wanted)
  });
  if (!body?.result?.id) fail("created_access_policy_missing_id");
  return {policy: body.result, created: true, updated: false, update_required: false};
}

async function ensureCa(accountId, appId, apply) {
  if (appId === "<planned>") {
    return {id: "<planned>", public_key: "<Cloudflare short-lived SSH CA public key>"};
  }
  const current = await cf(`/accounts/${accountId}/access/apps/${appId}/ca`, {}, [404]);
  if (current.status !== 404 && current.body?.result?.public_key) return current.body.result;
  if (!apply) return {id: "<planned>", public_key: "<Cloudflare short-lived SSH CA public key>"};
  const {body} = await cf(`/accounts/${accountId}/access/apps/${appId}/ca`, {
    method: "POST",
    body: JSON.stringify({})
  });
  if (!body?.result?.public_key) fail("cloudflare_ssh_ca_public_key_missing");
  return body.result;
}

function writeOutput(output) {
  const path = String(process.env.CITADEL_CF_OUTPUT || "").trim();
  const json = JSON.stringify(output, null, 2) + "\n";
  if (path) fs.writeFileSync(path, json, {encoding: "utf8", mode: 0o600});
  process.stdout.write(json);
}

function selfTest() {
  const cases = [
    [normalizeHostname("SSH.Example.COM."), "ssh.example.com"],
    [normalizeEmail(" User@example.com "), "user@example.com"],
    [normalizeTunnelName("citadel-ssh-node_1"), "citadel-ssh-node_1"],
    [normalizeSession("1h"), "1h"],
    [sshUserFromEmail("operator@example.com"), "operator"]
  ];
  for (const [actual, expected] of cases) if (actual !== expected) fail(`self_test_mismatch_${actual}_${expected}`);
  for (const bad of ["https://ssh.example.com", "localhost", "ssh_example.com"]) {
    let rejected = false;
    try { normalizeHostname(bad); } catch { rejected = true; }
    if (!rejected) fail("self_test_bad_hostname_accepted");
  }
  for (const bad of ["shared-tunnel", "ssh-node-1"]) {
    let rejected = false;
    try { normalizeTunnelName(bad); } catch { rejected = true; }
    if (!rejected) fail("self_test_unowned_tunnel_name_accepted");
  }
  for (const bad of ["5m", "8h", "1d"]) {
    let rejected = false;
    try { normalizeSession(bad); } catch { rejected = true; }
    if (!rejected) fail("self_test_bad_session_accepted");
  }
  console.log("Cloudflare SSH provisioner self-test: PASS");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const apply = String(process.env.CITADEL_CF_APPLY || "").toLowerCase() === "true" ||
    process.env.CITADEL_CF_APPLY === "1";
  const hostname = normalizeHostname(process.env.CITADEL_SSH_HOSTNAME);
  const allowedEmail = normalizeEmail(process.env.CITADEL_SSH_ALLOWED_EMAIL);
  const sshUser = sshUserFromEmail(allowedEmail);
  const nodeLabel = String(process.env.CITADEL_SSH_NODE_ID || sshUser).trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "node";
  const tunnelName = normalizeTunnelName(process.env.CITADEL_SSH_TUNNEL_NAME || `citadel-ssh-${nodeLabel}`);
  const sessionDuration = normalizeSession(process.env.CITADEL_SSH_SESSION_DURATION || "1h");
  const accountId = readAccountId();

  token();

  // Preflight every conflict-prone resource before the first write.
  const zone = await findZone(hostname, accountId);
  const tunnelPlan = await ensureTunnel(accountId, tunnelName, false);
  const ingressPlan = await ensureTunnelIngress(accountId, tunnelPlan.tunnel.id, hostname, false);
  const dnsPlan = await ensureDns(zone.id, hostname, tunnelPlan.tunnel.id, false);
  const appPlan = await ensureAccessApp(accountId, hostname, nodeLabel, sessionDuration, false);
  const policyPlan = await ensurePolicy(accountId, appPlan.app.id, hostname, allowedEmail, false);
  const caPlan = await ensureCa(accountId, appPlan.app.id, false);

  if (!apply) {
    return writeOutput({
      schema: "citadel.cloudflare-ssh.v1",
      applied: false,
      account_id: accountId,
      zone: {id: zone.id, name: zone.name},
      tunnel: {
        id: tunnelPlan.tunnel.id,
        name: tunnelPlan.tunnel.name,
        status: tunnelPlan.tunnel.status || "unknown",
        created: tunnelPlan.created
      },
      ingress: ingressPlan,
      dns: {
        id: dnsPlan?.id || null,
        name: hostname,
        target: tunnelPlan.tunnel.id === "<planned>"
          ? "<tunnel-id>.cfargotunnel.com"
          : `${tunnelPlan.tunnel.id}.cfargotunnel.com`
      },
      access_app: {
        id: appPlan.app.id,
        domain: hostname,
        type: appPlan.app.type || "ssh",
        created: appPlan.created,
        updated: false,
        update_required: appPlan.update_required,
        session_duration: appPlan.app.session_duration || sessionDuration
      },
      access_policy: {
        id: policyPlan.policy?.id || null,
        decision: "allow",
        allowed_email: allowedEmail,
        created: policyPlan.created,
        updated: false,
        update_required: policyPlan.update_required
      },
      ssh_user: sshUser,
      ca: {id: caPlan?.id || null, public_key: caPlan?.public_key || null},
      tunnel_token_stored: false,
      next_local_step: "Re-run with apply=true after reviewing this conflict-checked plan."
    });
  }

  // Apply Access controls before publishing SSH routing.
  const {tunnel, created: tunnelCreated} = await ensureTunnel(accountId, tunnelName, true);
  const {app, created: appCreated, updated: appUpdated, update_required: appUpdateRequired} =
    await ensureAccessApp(accountId, hostname, nodeLabel, sessionDuration, true);
  const {policy, created: policyCreated, updated: policyUpdated, update_required: policyUpdateRequired} =
    await ensurePolicy(accountId, app.id, hostname, allowedEmail, true);
  const ca = await ensureCa(accountId, app.id, true);
  const ingress = await ensureTunnelIngress(accountId, tunnel.id, hostname, true);
  const dns = await ensureDns(zone.id, hostname, tunnel.id, true);

  writeOutput({
    schema: "citadel.cloudflare-ssh.v1",
    applied: true,
    account_id: accountId,
    zone: {id: zone.id, name: zone.name},
    tunnel: {id: tunnel.id, name: tunnel.name, status: tunnel.status || "unknown", created: tunnelCreated},
    ingress,
    dns: {id: dns?.id || null, name: hostname, target: `${tunnel.id}.cfargotunnel.com`},
    access_app: {
      id: app.id,
      domain: hostname,
      type: app.type || "ssh",
      created: appCreated,
      updated: appUpdated,
      update_required: appUpdateRequired,
      session_duration: app.session_duration || sessionDuration
    },
    access_policy: {
      id: policy?.id || null,
      decision: "allow",
      allowed_email: allowedEmail,
      created: policyCreated,
      updated: policyUpdated,
      update_required: policyUpdateRequired
    },
    ssh_user: sshUser,
    ca: {id: ca?.id || null, public_key: ca?.public_key || null},
    tunnel_token_stored: false,
    next_local_step: "Run the CITADEL restricted SSH bootstrap as Administrator and paste the Cloudflare CA public key plus the tunnel token locally."
  });
}

main().catch(error => {
  console.error("CITADEL Cloudflare SSH provisioning failed:", error?.message || String(error));
  process.exit(1);
});
