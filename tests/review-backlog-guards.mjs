import fs from "node:fs";
function need(value, message) { if (!value) throw new Error(message); }
const index = fs.readFileSync("src/index.js", "utf8");
const setup = fs.readFileSync("agent/setup_windows.ps1", "utf8");
const serviceHost = fs.readFileSync("agent/CitadelNodeService.cs", "utf8");
const enterpriseProbe = fs.readFileSync("agent/windows_enterprise_probe.ps1", "utf8");
const serviceHelper = fs.readFileSync("agent/windows_service.ps1", "utf8");
const readme = fs.readFileSync("agent/README_RU.md", "utf8");
const nodeTest = fs.readFileSync("node-test.html", "utf8");
const agentV1 = fs.readFileSync("agent/citadel_node_v1.py", "utf8");
const agentV2 = fs.readFileSync("agent/citadel_node_v2.py", "utf8");
const telemetry = fs.readFileSync("src/telemetry/normalize.js", "utf8");
const telemetryCommon = fs.readFileSync("src/telemetry/common.js", "utf8");
const telemetryIngest = fs.readFileSync("src/telemetry/ingest.js", "utf8");
const telemetrySchema = fs.readFileSync("src/telemetry/schema.js", "utf8");
const worker = fs.readFileSync("src/worker.js", "utf8");
const wrangler = fs.readFileSync("wrangler.jsonc", "utf8");
const buildSite = fs.readFileSync("scripts/build_site.sh", "utf8");
const hub = fs.readFileSync("hub.html", "utf8");
const operations = fs.readFileSync("operations.html", "utf8");
const sshConsole = fs.readFileSync("agent/ssh_restricted_console.py", "utf8");
const sshMigration = fs.readFileSync("migrations/0020_ssh_zero_trust.sql", "utf8");
const sshBootstrapMigration = fs.readFileSync("migrations/0021_ssh_bootstrap_readiness.sql", "utf8");
const windowsSshConsole = fs.readFileSync("agent/CitadelSshConsole.cs", "utf8");
const windowsSshBootstrap = fs.readFileSync("agent/configure_restricted_ssh.ps1", "utf8");
const oneClickBuilder = fs.readFileSync("scripts/build_windows_oneclick.ps1", "utf8");
const oneClickIss = fs.readFileSync("agent/windows/CitadelEWS.iss", "utf8");
const deployWorkflow = fs.readFileSync(".github/workflows/deploy-cloudflare.yml", "utf8");
const sshCloudflareProvisioner = fs.readFileSync("scripts/provision_cloudflare_ssh.mjs", "utf8");
const sshCloudflareWorkflow = fs.readFileSync(".github/workflows/provision-ssh-zero-trust.yml", "utf8");
need(index.includes("auto_enrollment_windows"), "global auto-enrollment window missing");
need(index.includes("AUTO_ENROLL_MAX_NEW_PER_HOUR"), "enrollment hourly setting missing");
need(index.includes("AUTO_ENROLL_MAX_NODES"), "enrollment node cap setting missing");
need(index.includes("auto_enrollment_rate_limited"), "enrollment rate error missing");
need(index.includes("INSERT OR IGNORE INTO node_numbers"), "legacy number reconciliation missing");
need(index.includes("nn.node_number"), "Architect permanent node number missing");
need(index.includes("LEFT JOIN node_numbers AS nn"), "Architect node number join missing");
need(!readme.includes("-EnrollmentToken"), "README still documents EnrollmentToken");
need(!nodeTest.includes("enrollment_token"), "browser still sends enrollment_token");
need(!nodeTest.includes("tokenInput"), "browser still depends on token input");
need(agentV1.includes('VERSION = "0.3.30"'), "v1 release not bumped");
need(agentV2.includes('VERSION = "0.3.30"'), "v2 release not bumped");
need(agentV1.includes("hardware_snapshot"), "node hardware snapshot missing");
need(agentV1.includes("gpu_inventory"), "GPU/VRAM discovery missing");
need(agentV1.includes('"hardware"'), "hardware heartbeat payload missing");
need(agentV1.includes("hardware_doctor_snapshot"), "read-only Hardware Doctor missing");
need(agentV1.includes("network_doctor_snapshot"), "Network Doctor missing");
need(agentV1.includes('"hardware_doctor_readonly"'), "Hardware Doctor capability missing");
need(agentV1.includes('"usb_scanning": False'), "Hardware Doctor must explicitly exclude USB scanning");
need(agentV1.includes('"firmware_metadata_available"'), "NIC firmware metadata check missing");
need(agentV1.includes('"vpd_metadata_available"'), "PCI/VPD metadata check missing");
need(agentV1.includes('"controller_dns"'), "Network Doctor DNS stage missing");
need(agentV1.includes('"controller_tcp"'), "Network Doctor Controller TCP stage missing");
need(!agentV1.includes("eeupdate64e"), "firmware writer must not be embedded in agent");
need(!agentV1.includes("iqvlinux"), "legacy low-level IQV driver must not be embedded in agent");
need(agentV1.includes('"ssh_probe_readonly"'), "SSH readiness capability missing");
need(agentV1.includes('"ssh_probe"'), "signed SSH readiness probe missing");
need(agentV1.includes("SSH_RESTRICTED_CONSOLE_SHA256"), "restricted SSH console is not hash-pinned in the agent");
need(index.includes("node_ssh_state"), "Controller SSH state storage missing");
need(index.includes("ssh_secret_material_not_allowed"), "Controller does not reject SSH secret material");
need(index.includes("private_keys_stored: false"), "Controller must explicitly report no private SSH keys stored");
need(hub.includes("/ssh"), "Hub SSH state endpoint integration missing");
need(hub.includes("browser_terminal_local_ready"), "Hub does not gate Browser SSH on node readiness");
need(hub.includes("Открыть интерактивный SSH"), "Hub interactive SSH launcher missing");
need(sshMigration.includes("public_hostname") && sshMigration.includes("host_key_fingerprint"), "SSH public configuration migration incomplete");
need(!sshMigration.toLowerCase().includes("private_key"), "SSH migration must not store private keys");
need(sshConsole.includes("ALLOWED_COMMANDS"), "restricted SSH allow-list missing");
need(!sshConsole.includes("import subprocess"), "restricted SSH console must not import subprocess");
need(!sshConsole.includes("shell=True"), "restricted SSH console must never enable a shell");
need(agentV1.includes('"CitadelSshConsole.cs"') && agentV1.includes('"configure_restricted_ssh.ps1"'), "agent update allow-list must accept signed SSH bootstrap assets");
need(agentV1.includes('"windows_restricted_ssh_bootstrap"'), "Windows SSH bootstrap capability missing");
need(index.includes("restricted_policy_ready"), "Controller restricted SSH policy gate missing");
need(index.includes("n.capabilities_json"), "Hub overview must expose node capabilities for bootstrap eligibility");
need(hub.includes('id="copySshBootstrapButton"'), "Hub Windows SSH bootstrap action missing");
need(hub.includes("windows_restricted_ssh_bootstrap"), "Hub must gate SSH bootstrap on reported capability");
need(hub.includes("restricted_policy_ready"), "Hub restricted SSH policy status missing");
need(sshBootstrapMigration.includes("restricted_policy_ready"), "SSH bootstrap readiness migration missing");
need(!sshBootstrapMigration.toLowerCase().includes("private_key"), "SSH bootstrap migration must not store private keys");
need(windowsSshBootstrap.includes("ListenAddress 127.0.0.1"), "Windows SSH bootstrap must bind loopback only");
need(windowsSshBootstrap.includes("AllowUsers $SshUser"), "Windows SSH bootstrap must restrict daemon to the dedicated user");
need(windowsSshBootstrap.includes("PasswordAuthentication no"), "Windows SSH bootstrap must disable password auth");
need(windowsSshBootstrap.includes("AllowAgentForwarding no"), "Windows SSH bootstrap must disable agent forwarding");
need(windowsSshBootstrap.includes("AllowTcpForwarding no") && windowsSshBootstrap.includes("GatewayPorts no"), "Windows SSH bootstrap must disable TCP forwarding and gateway ports");
need(windowsSshBootstrap.includes("Disable-NetFirewallRule"), "Windows SSH bootstrap must disable the public OpenSSH firewall rule");
need(windowsSshBootstrap.includes("& $SshdExe -t -f $SshdConfig"), "Windows SSH bootstrap must validate sshd_config before restart");
need(!windowsSshBootstrap.includes("-ExecutionPolicy Bypass"), "Windows SSH bootstrap must not bypass PowerShell policy");
need(windowsSshBootstrap.includes('"RemoteSigned"'), "Windows SSH bootstrap elevation must use process-only RemoteSigned policy");
need(hub.includes("-ExecutionPolicy RemoteSigned") && !hub.includes("-ExecutionPolicy Bypass"), "Hub SSH bootstrap must use RemoteSigned without Bypass");
need(oneClickIss.includes("-ExecutionPolicy RemoteSigned") && !oneClickIss.includes("-ExecutionPolicy Bypass"), "one-click SSH cleanup must use RemoteSigned without Bypass");
for (const unsupported of ["KbdInteractiveAuthentication", "PermitTunnel", "X11Forwarding"]) {
  need(!windowsSshBootstrap.includes(unsupported), `Windows OpenSSH unsupported directive returned: ${unsupported}`);
}
need(windowsSshBootstrap.includes("Windows OpenSSH did not generate sshd_config on first service start."), "fresh OpenSSH config generation guard missing");
need(!windowsSshConsole.includes("Process.Start("), "Windows restricted SSH console must not spawn child processes");
need(!windowsSshConsole.includes("UseShellExecute"), "Windows restricted SSH console must not enable shell execution");
need(windowsSshConsole.includes("SSH_ORIGINAL_COMMAND"), "Windows restricted SSH console must support OpenSSH ForceCommand input");
need(windowsSshBootstrap.includes("Resolve-AgentLayout") && windowsSshBootstrap.includes('"flat_oneclick"'), "Windows SSH bootstrap must support one-click flat layout");
need(oneClickBuilder.includes('"CitadelSshConsole.cs"') && oneClickBuilder.includes('"configure_restricted_ssh.ps1"'), "one-click builder must package restricted SSH assets");
need(oneClickIss.includes("configure_restricted_ssh.ps1") && oneClickIss.includes("-Uninstall"), "one-click uninstaller must clean restricted SSH state");
need(windowsSshBootstrap.includes("Read-Host $Prompt -AsSecureString"), "Tunnel token must be entered locally as hidden input");
need(windowsSshBootstrap.includes("$Cloudflared service install $PlainTunnelToken"), "cloudflared service installation path missing");
need(windowsSshBootstrap.includes("cloudflared_service_created_by_citadel"), "cloudflared ownership marker missing");
need(windowsSshBootstrap.includes("service uninstall"), "CITADEL-created cloudflared service cleanup missing");
need(!windowsSshBootstrap.includes("[string]$CloudflareTunnelToken"), "Tunnel token must not be accepted as a command-line parameter");
need(!windowsSshBootstrap.includes("tunnel_token ="), "Tunnel token must not be persisted in bootstrap state");
need(sshCloudflareProvisioner.includes('service: "ssh://localhost:22"'), "Cloudflare tunnel SSH ingress missing");
need(sshCloudflareProvisioner.includes('type: "ssh"'), "Cloudflare Access Browser SSH app missing");
need(sshCloudflareProvisioner.includes("allowed_email"), "Cloudflare Access exact-email policy output missing");
need(sshCloudflareProvisioner.includes("/ca"), "Cloudflare short-lived SSH CA provisioning missing");
need(sshCloudflareProvisioner.includes("tunnel_token_stored: false"), "Cloudflare provisioner must explicitly keep tunnel tokens out of output");
need(!sshCloudflareProvisioner.includes("/token"), "Cloudflare provisioner must not retrieve the tunnel token into Actions");
need(sshCloudflareWorkflow.includes("environment: cloudflare-test"), "SSH Cloudflare provisioning must use the protected environment");
need(sshCloudflareWorkflow.includes("FULL_CLOUDFLARE_CONTROL") && sshCloudflareWorkflow.includes("CLOUDFLARE_API_TOKEN"), "SSH workflow Cloudflare secret fallback missing");
need(!/env:\n\s{6}(?:FULL_CLOUDFLARE_CONTROL|CLOUDFLARE_API_TOKEN):/.test(sshCloudflareWorkflow), "Cloudflare API secrets must not be job-wide environment variables");
need(sshCloudflareProvisioner.includes('new Set(["30m", "1h", "2h", "4h"])'), "Cloudflare Access session duration is not bounded");
need(sshCloudflareWorkflow.includes("workflow_dispatch:"), "SSH Cloudflare provisioning must be explicitly dispatched");
need(sshCloudflareWorkflow.includes("apply:") && sshCloudflareWorkflow.includes("default: false"), "SSH Cloudflare provisioning must default to dry-run");
need(!sshCloudflareWorkflow.includes("cfd_tunnel/$TUNNEL_ID/token"), "SSH workflow must never print or retrieve tunnel tokens");
need(setup.includes('ServiceName = "CitadelEWSNode"'), "Windows Core Service name missing");
need(setup.includes('LegacyUserSid'), "original user SID preservation missing");
need(setup.includes('Set-CitadelDirectoryAcl'), "Windows clean ACL reconstruction missing");
need(setup.includes('"PAUSED"'), "paused-state migration missing");
need(setup.includes('Set-CitadelServiceDefinition'), "verified SCM service configuration missing");
need(setup.includes('Restore-CitadelServiceDefinition'), "service rollback path missing");
need(setup.includes('-Uninstall'), "Windows service uninstall flow missing");
need(setup.includes('ProgramData\\CitadelEWS\\state'), "Windows service state is not machine-scoped");
need(!setup.includes('CreateShortcut('), "core agent still creates a Startup shortcut");
need(serviceHelper.includes('Invoke-CimMethod'), "Windows SCM API helper missing");
need(serviceHelper.includes('DelayedAutostart'), "Windows delayed-auto verification missing");
need(serviceHost.includes('ServiceBase.Run'), "Windows SCM service host missing");
need(serviceHost.includes('AutoLog = false'), "Windows service must not require an EventLog source");
need(serviceHost.includes('CITADEL_SERVICE_STOP_FILE'), "transient service stop channel missing");
need(serviceHost.includes('RequestAdditionalTime(60000)'), "SCM stop wait hint missing");
need(serviceHost.includes('RestartExitCode = 75'), "service restart supervision missing");
need(agentV1.includes('"windows_enterprise_readonly"'), "enterprise probe capability missing");
need(agentV1.includes("WINDOWS_ENTERPRISE_PROBE_SHA256"), "enterprise probe hash pin missing");
need(enterpriseProbe.includes("Get-CimInstance"), "enterprise CIM probe missing");
need(enterpriseProbe.includes("Get-WinEvent"), "enterprise Event Log probe missing");
need(enterpriseProbe.includes("Get-VM"), "enterprise Hyper-V read-only adapter missing");
need(enterpriseProbe.includes("IntuneManagementExtension"), "enterprise Intune detection missing");
for (const forbidden of ["Invoke-Expression", "DownloadString", "Enable-PSRemoting", "Invoke-Command", "New-PSSession"]) {
  need(!enterpriseProbe.includes(forbidden), `unsafe enterprise probe primitive returned: ${forbidden}`);
}
need(agentV1.includes('SERVICE_RESTART_EXIT_CODE = 75'), "agent service restart exit code missing");
need(agentV1.includes('SERVICE_STOP_EXIT_CODE = 76'), "agent service stop exit code missing");
need(agentV1.includes('"windows_core_service"'), "SCM service capability marker missing");
need(agentV1.includes("windows-dpapi-local-machine-v1"), "Windows DPAPI identity protection missing");
need(agentV1.includes("CryptProtectData"), "Windows DPAPI protect call missing");
need(agentV1.includes("CryptUnprotectData"), "Windows DPAPI unprotect call missing");
need(agentV1.includes("private_key_dpapi"), "protected Windows identity field missing");
need(setup.includes("DirectorySecurity"), "Windows state ACL reconstruction missing");
need(agentV2.includes('"windows_sleep_hibernate_inhibit"'), "agent drops sleep/hibernate event");
need(agentV2.includes('"network_recovery_not_needed"'), "agent drops network recovery no-op event");
for (const eventType of [
  "windows_sleep_hibernate_inhibit",
  "agent_updated",
  "agent_update_rolled_back",
  "agent_update_healthcheck_passed",
  "agent_update_manual_rollback",
  "agent_restart_requested",
  "agent_stop_requested",
  "system_reboot_scheduled",
  "system_shutdown_scheduled",
  "wake_packet_sent",
  "lmstudio_installed",
  "lmstudio_model_downloaded",
  "lmstudio_model_loaded",
  "lmstudio_state_report_failed",
  "hybrid_query_completed",
  "network_recovery_failed",
  "network_recovery_attempted",
  "windows_sleep_hibernate_inhibit"
]) {
  need(telemetry.includes(`"${eventType}"`), `controller drops ${eventType}`);
}
need(index.includes('"restart", "stop", "rollback"'), "non-revoking stop command missing from Controller allow-list");
need(agentV1.includes('"restart", "stop", "rollback"'), "non-revoking stop command missing from node allow-list");
need(index.includes('"system_reboot", "system_shutdown"'), "restricted power commands missing from Controller allow-list");
need(agentV1.includes('"system_reboot", "system_shutdown"'), "restricted power commands missing from node allow-list");
need(index.includes('"wake_peer"'), "wake relay command missing from Controller");
need(agentV1.includes('"wake_peer"'), "wake relay command missing from node allow-list");
need(index.includes('"lmstudio_install"'), "LM Studio install command missing from Controller allow-list");
need(index.includes('"lmstudio_model_get"'), "LM Studio model download command missing from Controller allow-list");
need(index.includes('"lmstudio_model_load"'), "LM Studio model load command missing from Controller allow-list");
need(agentV1.includes('"lmstudio_install"'), "LM Studio install command missing from node allow-list");
need(agentV1.includes("validate_lmstudio_model_payload"), "LM Studio model validation missing");
need(agentV1.includes("windows_sleep_hibernate_inhibit"), "sleep/hibernate inhibition missing");
need(telemetryCommon.includes("replayed_request"), "telemetry replay rejection missing");
need(index.includes("node_request_nonces"), "Controller request nonce storage missing");
need(index.includes("agentRequiresRequestId"), "Controller compatibility gate for replay protection missing");
need(index.includes("replayed_request"), "Controller replay rejection missing");
need(index.includes('requestId.endsWith("0")'), "nonce cleanup must be opportunistic instead of every signed poll");
need(index.includes("received_at < datetime('now', '-10 minutes')"), "nonce cleanup must use the received_at index");
need(!index.includes("datetime(received_at) < datetime('now', '-10 minutes')"), "nonce cleanup must not wrap the indexed timestamp column");
need(!telemetryIngest.includes("retentionKey.endsWith"), "telemetry retention must not depend on node-controlled event IDs");
need(!telemetryIngest.includes("datetime(received_at) < datetime('now', '-7 days')"), "telemetry ingestion must not full-scan received_at retention");
need(telemetrySchema.includes("received_at < datetime('now', '-7 days')"), "telemetry prune helper must use the received_at index");
need(worker.includes("async scheduled(_controller, env)") && worker.includes("pruneExpiredTelemetry(env)"), "scheduled telemetry retention missing");
need(wrangler.includes('"17 * * * *"'), "telemetry retention cron missing");
{
  const rolloutStart = index.indexOf("async function ensureRolloutCommandForNode");
  const rolloutEnd = index.indexOf("const WORK_ROLE_REGISTRY", rolloutStart);
  const rolloutBlock = rolloutStart >= 0 && rolloutEnd > rolloutStart ? index.slice(rolloutStart, rolloutEnd) : "";
  const noRolloutReturn = rolloutBlock.indexOf("if (!rollout) return;");
  const staleCleanup = rolloutBlock.indexOf("await expireStaleNodeCommands(env, nodeId);");
  need(noRolloutReturn >= 0 && staleCleanup > noRolloutReturn, "steady-state command polling must skip stale cleanup when no rollout is active");
}
{
  const listStart = index.indexOf("async function listCommands");
  const listEnd = index.indexOf("async function acknowledgeCommand", listStart);
  const listBlock = listStart >= 0 && listEnd > listStart ? index.slice(listStart, listEnd) : "";
  need(!listBlock.includes("expireStaleNodeCommands"), "normal command polling must not scan stale commands every cycle");
  need(listBlock.includes("datetime(created_at) >= datetime(?)"), "normal command polling must hide expired commands without cleanup scans");
}
need(index.includes("do {") && index.includes("expiredBatchSize = await expireStaleCommands(env);") && index.includes("while (expiredBatchSize === 250);"), "command storage must drain every full stale-command batch before creating the active-command unique index");
need(index.includes('throw new ApiError(409, "command_already_pending")'), "command storage UNIQUE conflicts must not surface as internal_error");
{
  const start = index.indexOf("async function architectCreateCommand");
  const end = index.indexOf("async function nodeUpdateAiState", start);
  const block = start >= 0 && end > start ? index.slice(start, end) : "";
  const expireAt = block.indexOf("await expireStaleNodeCommands(env, nodeId);");
  const storageAt = block.indexOf("await ensureCommandStorage(env);");
  need(
    storageAt >= 0 && expireAt > storageAt,
    "Architect command path must bootstrap command storage before stale-command cleanup"
  );
}
need(index.includes("expireStaleNodeCommands"), "stale command expiry missing");
need(agentV1.includes("x-node-request-id"), "agent request nonce header missing");
need(agentV1.includes("recover_network"), "bounded network recovery missing");
need(agentV1.includes('"always_on_guard"'), "always-on capability missing");
need(agentV1.includes('"known_network_recovery"'), "known-network recovery capability missing");
need(agentV1.includes("prevent_automatic_sleep"), "automatic sleep guard config missing");
need(agentV1.includes("allowed_wifi_profiles"), "Wi-Fi recovery allowlist missing");
need(agentV1.includes("controller_reachable"), "network recovery reachability verification missing");
need(agentV1.includes("wifi_primary_retry:") && agentV1.includes("wifi_fallback_profile:"), "preferred/fallback Wi-Fi recovery loop missing");
need(agentV1.includes("SetThreadExecutionState"), "Windows power execution-state guard missing");
need(agentV1.includes("stream_lmstudio_answer"), "streaming Hybrid answer missing");
need(agentV1.includes("/api/v1/models/download/status/"), "LM Studio download progress polling missing");
need(index.includes("node_ai_runtime_state"), "extended AI runtime state missing");
need(index.includes("nodeUpdateAiState"), "signed node AI-state endpoint missing");
need(index.includes("architectSearchModels"), "Hugging Face model search missing");
need(index.includes("architectRecommendModels"), "node-aware model recommendation endpoint missing");
need(index.includes("node_hardware_state"), "node hardware storage missing");
need(index.includes("modelRecommendationProfile"), "hardware model sizing logic missing");
need(index.includes("openrouter_quality"), "OpenRouter health state missing");
need(operations.includes("recommendModelsForNode"), "operations model recommendation action missing");
need(operations.includes("/models/search?q="), "operations Hugging Face search missing");
need(operations.includes("modelSource"), "operations model source selector missing");
need(deployWorkflow.includes("/tmp/openrouter-key"), "OpenRouter key normalization missing");
need(deployWorkflow.includes("OpenRouter key probe: authenticated"), "OpenRouter authentication probe missing");
need(index.includes('"lmstudio_probe"'), "LM Studio probe command missing from Controller allow-list");
need(index.includes('"hybrid_query"'), "Hybrid command missing from Controller allow-list");
need(agentV1.includes("validate_hybrid_payload"), "Hybrid payload validation missing");
need(agentV1.includes("execute_project_text"), "LM Studio project text worker missing");
need(agentV1.includes("_project_llm_chat"), "local LLM mini-agent chat helper missing");
need(agentV1.includes("llm-mini-"), "bounded LLM mini-agent orchestration missing");
need(agentV1.includes("mini_agent_count"), "LLM mini-agent result metadata missing");
need(agentV1.includes('"project_text"'), "project_text capability missing");
need(agentV1.includes('"127.0.0.1"'), "project worker must stay on local LM Studio endpoint");
need(index.includes("materializeProjectWorkForNode"), "planned project materializer missing");
need(index.includes("waiting_for_lmstudio_project_worker"), "planned project waiting reason missing");
need(index.includes("final_report:"), "project final report aggregation missing");
need(index.includes("project_execution"), "project execution readiness health missing");
need(index.includes("project_ai_ready_workers"), "AI project worker readiness count missing");
need(index.includes("project_python_ready_workers"), "Python project worker readiness count missing");
need(agentV1.includes("shell=False"), "fixed argv execution guard missing");
need(!agentV1.includes('"shell" in SUPPORTED_COMMANDS'), "arbitrary shell command registered");
need(!buildSite.includes("execute-api.*.amazonaws.com"), "invalid CSP API Gateway wildcard returned");
need(buildSite.includes("connect-src 'self';"), "published CSP must keep same-origin connect-src");
need(hub.includes("async function waitForRefreshIdle()"), "Hub secure login refresh-race guard missing");
need(hub.includes("citadel-architect-token"), "Hub Architect session handling missing");
need(hub.includes("if(!(await waitForRefreshIdle()))"), "Hub login does not wait for background refresh");
const hubLoginStart = hub.indexOf('loginButton.addEventListener("click"');
const hubLoginEnd = hub.indexOf('logoutButton.addEventListener("click"', hubLoginStart);
const hubLoginBlock = hub.slice(hubLoginStart, hubLoginEnd);
need(hubLoginStart >= 0 && hubLoginEnd > hubLoginStart, "Hub login handler missing");
need(hubLoginBlock.indexOf("await waitForRefreshIdle()") < hubLoginBlock.indexOf("architectToken=value"), "Hub assigns replacement token before stale refresh is idle");
need(index.includes('version: "0.3.30"'), "Controller release not bumped");
need(index.includes('path: "CitadelSshConsole.cs"'), "0.3.30 release must deliver the restricted SSH console source");
need(index.includes('path: "configure_restricted_ssh.ps1"'), "0.3.30 release must deliver the restricted SSH bootstrap");
console.log("Review backlog guards: PASS");

need(agentV1.includes("lmstudio_heartbeat_probe_failed"), "routine heartbeat does not refresh LM Studio readiness");
