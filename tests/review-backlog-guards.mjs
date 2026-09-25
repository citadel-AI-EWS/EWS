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
const heartbeatCompaction = fs.readFileSync("migrations/0014_compact_heartbeat_audit.sql", "utf8");
const buildSite = fs.readFileSync("scripts/build_site.sh", "utf8");
const hub = fs.readFileSync("hub.html", "utf8");
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
need(agentV1.includes('VERSION = "0.3.15"'), "v1 release not bumped");
need(agentV2.includes('VERSION = "0.3.15"'), "v2 release not bumped");
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
need(index.includes("await expireStaleNodeCommands(env, nodeId);\n  await ensureRolloutCommandForNode(env, nodeId);"), "stale command expiry must run before rollout scheduling");
need(!index.includes("'node.heartbeat'"), "routine heartbeat must not append audit_events rows");
need(index.includes('"automatic_latest_" + targetVersion'), "automatic latest agent rollout missing");
need(index.includes("recentFailedUpdate"), "automatic rollout failure cooldown missing");
need(heartbeatCompaction.includes("DELETE FROM audit_events"), "legacy heartbeat audit compaction migration missing");
need(heartbeatCompaction.includes("action = 'node.heartbeat'"), "heartbeat compaction migration targets wrong audit action");
need(index.includes("do {") && index.includes("expiredBatchSize = await expireStaleCommands(env);") && index.includes("while (expiredBatchSize === 250);"), "command storage must drain every full stale-command batch before creating the active-command unique index");
need(index.includes('throw new ApiError(409, "command_already_pending")'), "command storage UNIQUE conflicts must not surface as internal_error");
need(index.includes("await expireStaleNodeCommands(env, nodeId);\n  await ensureCommandStorage(env);"), "Architect command path must expire the target node before enforcing command index");
need(index.includes("expireStaleNodeCommands"), "stale command expiry missing");
need(agentV1.includes("x-node-request-id"), "agent request nonce header missing");
need(agentV1.includes("recover_network"), "bounded network recovery missing");
need(agentV1.includes('"always_on_guard"'), "always-on capability missing");
need(agentV1.includes('"known_network_recovery"'), "known-network recovery capability missing");
need(agentV1.includes("prevent_automatic_sleep"), "automatic sleep guard config missing");
need(agentV1.includes("allowed_wifi_profiles"), "Wi-Fi recovery allowlist missing");
need(agentV1.includes("controller_reachable"), "network recovery reachability verification missing");
need(agentV1.includes("wifi_saved_profile:"), "saved Wi-Fi profile recovery loop missing");
need(agentV1.includes("SetThreadExecutionState"), "Windows power execution-state guard missing");
need(agentV1.includes("stream_lmstudio_answer"), "streaming Hybrid answer missing");
need(agentV1.includes("/api/v1/models/download/status/"), "LM Studio download progress polling missing");
need(index.includes("node_ai_runtime_state"), "extended AI runtime state missing");
need(index.includes("nodeUpdateAiState"), "signed node AI-state endpoint missing");
need(index.includes("architectSearchModels"), "Hugging Face model search missing");
need(index.includes('"lmstudio_probe"'), "LM Studio probe command missing from Controller allow-list");
need(index.includes('"hybrid_query"'), "Hybrid command missing from Controller allow-list");
need(agentV1.includes("validate_hybrid_payload"), "Hybrid payload validation missing");
need(agentV1.includes("execute_project_text"), "LM Studio project text worker missing");
need(agentV1.includes('"project_text"'), "project_text capability missing");
need(agentV1.includes('"127.0.0.1"'), "project worker must stay on local LM Studio endpoint");
need(index.includes("materializeProjectWorkForNode"), "planned project materializer missing");
need(index.includes("waiting_for_lmstudio_project_worker"), "planned project waiting reason missing");
need(index.includes("final_report:"), "project final report aggregation missing");
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
need(index.includes('version: "0.3.15"'), "Controller release not bumped");
console.log("Review backlog guards: PASS");
