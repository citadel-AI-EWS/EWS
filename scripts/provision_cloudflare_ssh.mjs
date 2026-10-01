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
  if (exact.length === 1) return {tunnel: exact[0], created: false};
  if (!apply) return {tunnel: {id: "<planned>", name: tunnelName, config_src: "cloudflare"}, created: true};
  const {body} = await cf(`/accounts/${accountId}/cfd_tunnel`, {
    method: "POST",
    body: JSON.stringify({name: tunnelName, config_src: "cloudflare"})
  });
  if (!body?.result?.id) fail("created_tunnel_missing_id");
  return {tunnel: body.result, created: true};
}

async function ensureTunnelIngress(accountId, tunnelId, hostname, apply) {
  let ingress = [];
  if (tunnelId !== "<planned>") {
    const current = await cf(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {}, [404]);
    ingress = Array.isArray(current.body?.result?.config?.ingress) ? current.body.result.config.ingress : [];
  }
  const routes = ingress.filter(item => item && item.hostname && item.hostname !== hostname);
  routes.push({hostname, service: "ssh://localhost:22"});
  const catchAll = ingress.find(item => item && !item.hostname) || {service: "http_status:404"};
  routes.push(catchAll);
  if (apply && tunnelId !== "<planned>") {
    await cf(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({config: {ingress: routes}})
    });
  }
  return routes;
}

async function ensureDns(zoneId, hostname, tunnelId, apply) {
  if (tunnelId === "<planned>") {
    return {id: "<planned>", type: "CNAME", name: hostname, content: "<tunnel-id>.cfargotunnel.com", proxied: true};
  }
  const records = await listAll(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
  const desired = `${tunnelId}.cfargotunnel.com`;
  if (records.length > 1) fail("multiple_dns_records_for_ssh_hostname");
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
  const apps = await listAll(`/accounts/${accountId}/access/apps`);
  const matches = apps.filter(app => String(app?.domain || "").toLowerCase() === hostname);
  if (matches.length > 1) fail("multiple_access_apps_for_ssh_hostname");
  if (matches.length === 1) {
    if (matches[0].type !== "ssh") fail("existing_access_app_for_hostname_is_not_browser_ssh");
    if (!String(matches[0].name || "").startsWith("CITADEL SSH ")) {
      fail("existing_access_app_for_hostname_is_not_owned_by_citadel");
    }
    return {app: matches[0], created: false};
  }
  const desired = {
    name: `CITADEL SSH ${nodeLabel}`,
    domain: hostname,
    type: "ssh",
    session_duration: sessionDuration,
    app_launcher_visible: false
  };
  if (!apply) return {app: {id: "<planned>", ...desired}, created: true};
  const {body} = await cf(`/accounts/${accountId}/access/apps`, {
    method: "POST",
    body: JSON.stringify(desired)
  });
  if (!body?.result?.id) fail("created_access_app_missing_id");
  return {app: body.result, created: true};
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
  if (appId === "<planned>") return {id: "<planned>", ...desiredPolicy(hostname, email)};
  const policies = await listAll(`/accounts/${accountId}/access/apps/${appId}/policies`);
  const incompatible = policies.filter(p => !["allow", "deny"].includes(String(p?.decision || "")));
  if (incompatible.length) fail("browser_ssh_app_contains_unsupported_bypass_or_service_auth_policy");
  const wanted = desiredPolicy(hostname, email);
  const unexpected = policies.filter(p => p?.name !== wanted.name);
  if (unexpected.length) fail("browser_ssh_app_contains_additional_policy");
  const existing = policies.find(p => p?.name === wanted.name);
  if (existing && existing.decision !== "allow") fail("citadel_ssh_policy_has_wrong_decision");
  if (!apply) return existing || {id: "<planned>", ...wanted};
  if (existing?.id) {
    const {body} = await cf(`/accounts/${accountId}/access/apps/${appId}/policies/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(wanted)
    });
    return body.result;
  }
  const {body} = await cf(`/accounts/${accountId}/access/apps/${appId}/policies`, {
    method: "POST",
    body: JSON.stringify(wanted)
  });
  return body.result;
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

  if (apply) token();

  const zone = apply ? await findZone(hostname, accountId) : {id: "<planned>", name: hostname.split(".").slice(-2).join(".")};
  const {tunnel, created: tunnelCreated} = apply
    ? await ensureTunnel(accountId, tunnelName, true)
    : {tunnel: {id: "<planned>", name: tunnelName, config_src: "cloudflare"}, created: true};
  const ingress = await ensureTunnelIngress(accountId, tunnel.id, hostname, apply);
  const dns = await ensureDns(zone.id, hostname, tunnel.id, apply);
  const {app, created: appCreated} = await ensureAccessApp(accountId, hostname, nodeLabel, sessionDuration, apply);
  const policy = await ensurePolicy(accountId, app.id, hostname, allowedEmail, apply);
  const ca = await ensureCa(accountId, app.id, apply);

  writeOutput({
    schema: "citadel.cloudflare-ssh.v1",
    applied: apply,
    account_id: accountId,
    zone: {id: zone.id, name: zone.name},
    tunnel: {id: tunnel.id, name: tunnel.name, status: tunnel.status || "unknown", created: tunnelCreated},
    ingress,
    dns: {id: dns?.id || null, name: hostname, target: tunnel.id === "<planned>" ? "<tunnel-id>.cfargotunnel.com" : `${tunnel.id}.cfargotunnel.com`},
    access_app: {id: app.id, domain: hostname, type: app.type || "ssh", created: appCreated},
    access_policy: {id: policy?.id || null, decision: "allow", allowed_email: allowedEmail},
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
