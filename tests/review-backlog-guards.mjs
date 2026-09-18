import fs from "node:fs";
function need(value, message) { if (!value) throw new Error(message); }
const index = fs.readFileSync("src/index.js", "utf8");
const setup = fs.readFileSync("agent/setup_windows.ps1", "utf8");
const readme = fs.readFileSync("agent/README_RU.md", "utf8");
const nodeTest = fs.readFileSync("node-test.html", "utf8");
const agentV1 = fs.readFileSync("agent/citadel_node_v1.py", "utf8");
const agentV2 = fs.readFileSync("agent/citadel_node_v2.py", "utf8");
const telemetry = fs.readFileSync("src/telemetry/normalize.js", "utf8");
const buildSite = fs.readFileSync("scripts/build_site.sh", "utf8");
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
need(setup.includes("$RunArguments"), "Windows paths are not quoted");
need(setup.includes("refusing to start another copy"), "process inspection is not fail-closed");
need(agentV1.includes('VERSION = "0.3.7"'), "v1 release not bumped");
need(agentV2.includes('VERSION = "0.3.7"'), "v2 release not bumped");
need(agentV2.includes('"windows_sleep_inhibit"'), "agent drops sleep event");
for (const eventType of [
  "windows_sleep_inhibit",
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
  "lmstudio_model_loaded"
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
need(index.includes('version: "0.3.7"'), "Controller release not bumped");
console.log("Review backlog guards: PASS");
