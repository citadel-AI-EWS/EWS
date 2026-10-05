import fs from "node:fs";
import assert from "node:assert/strict";

const architect = fs.readFileSync("architect.html", "utf8");
const hub = fs.readFileSync("hub.html", "utf8");
const logs = fs.readFileSync("architect-logs.html", "utf8");
const home = fs.readFileSync("live-index.html", "utf8");
const index = fs.readFileSync("src/index.js", "utf8");
const operations = fs.readFileSync("operations.html", "utf8");
const agent = fs.readFileSync("agent/citadel_node_v1.py", "utf8");
const deployWorkflow = fs.readFileSync(".github/workflows/deploy-cloudflare.yml", "utf8");
const autoEnrollmentMigration = fs.readFileSync("migrations/0013_auto_enrollment_storage.sql", "utf8");

assert.doesNotMatch(architect, /Контрольные точки/, "checkpoint UI must not be published");
assert.doesNotMatch(architect, /\/api\/v1\/architect\/sessions/, "Architect UI must not load checkpoint sessions");
assert.doesNotMatch(architect, /\/api\/v1\/architect\/storage/, "Architect UI must not load checkpoint storage");
for (const id of [
  "ipButton",
  "healthButton",
  "stopButton",
  "rebootButton",
  "shutdownButton",
  "nodeDiagnostics",
  "sshHost",
  "sshUser",
  "sshCommand",
  "missionTask",
  "missionCreateResult",
  "updateAllAgentsButton",
  "updateAllStatus",
  "projectTitle",
  "projectExecutionMode",
  "projectExecutionHint",
  "projectTaskText",
  "checkProjectButton",
  "createProjectButton",
  "projectChecks",
  "projectResult",
  "projectsList",
  "liveOperations",
  "liveNodesList",
  "fleetRing",
  "cpuChart",
  "memoryChart",
  "topologySvg",
  "operationsAlert",
  "operationsAlertList",
  "closeOperationsAlert",
  "unhealthyCount",
  "projectRolePlan",
  "workRoles",
  "missionPanel",
  "missionNodeState",
  "wakeButton",
  "wakeState",
  "updateAgentState",
  "agentUpdateProgress",
  "agentUpdateRing",
  "agentUpdatePercent",
  "agentUpdateFill",
  "agentUpdateStages",
  "siteClock",
  "projectCreatedOverlay",
  "projectCreatedSummary",
  "projectGoReportButton",
  "projectReportCard",
  "projectReportWorkItems",
  "projectFinalResultBox",
  "projectFinalResult",
  "projectVoiceButton",
  "missionVoiceButton",
  "reportsDisclosure",
  "lostTokenButton",
  "recoveryLoginPanel",
  "recoveryCodeInput",
  "recoverTokenButton",
  "architectSecurityState",
  "createRecoveryCodeButton",
  "rotateArchitectTokenButton",
  "securitySecretPanel",
  "securitySecretValue",
  "homeButton",
  "rbacPanel",
  "rbacRole",
  "rbacLabel",
  "createRbacTokenButton",
  "rbacTokenList",
  "enterpriseServicesCard",
  "enterpriseRoleBadge",
  "enterpriseSummary",
  "enterpriseServiceCatalog",
  "policyLatestAgent",
  "policyWindowsService",
  "policyEnterpriseProbe",
  "policyUpdateService",
  "policyNoPendingReboot",
  "policyDomainJoin",
  "policyGroupPolicy",
  "policyIntune",
  "policyHyperV",
  "policyManagedAccount",
  "policyCpu",
  "policyMemory",
  "policyEvents",
  "policyHeartbeatAge",
  "policyDiskFree",
  "policyLanAddress",
  "saveEnterprisePolicyButton",
  "newSiteName",
  "createSiteButton",
  "newGroupName",
  "createGroupButton",
  "enterpriseNodeSelect",
  "enterpriseSiteSelect",
  "enterpriseGroupSelect",
  "assignEnterpriseScopeButton",
  "refreshEnterpriseButton",
  "enterpriseNodeCompliance",
  "recoveryManifestButton",
  "recoveryManifestState"
]) {
  assert.match(architect, new RegExp(`id="${id}"`), `Architect control missing: ${id}`);
}
assert.match(architect, /\/api\/v1\/architect\/presence/);
assert.match(architect, /createInventoryMission/);
assert.match(architect, /task_text:/);
assert.match(architect, /Диагностика системы/);
assert.match(architect, /System Inventory — .*диагностика узла/);
assert.match(architect, /cloudflared access ssh --hostname %h/);
assert.match(architect, /sendControl\("stop"\)/);
assert.match(architect, /sendControl\("system_reboot", "REBOOT"\)/);
assert.match(architect, /sendControl\("system_shutdown", "SHUTDOWN"\)/);
assert.match(architect, /\/api\/v1\/architect\/update-all/);
assert.match(architect, /\/api\/v1\/architect\/projects\/check/);
assert.match(architect, /\/api\/v1\/architect\/projects/);
assert.match(architect, /\/api\/v1\/architect\/projects\/\$\{encodeURIComponent\(projectId\)\}/);
assert.match(architect, /requested_roles:/);
assert.match(architect, /SpeechRecognition|webkitSpeechRecognition/);
assert.match(architect, /Перейти к отчёту/);
assert.match(architect, /<details id="reportsDisclosure"/);
assert.match(architect, /Hub выбрал автоматически/);
assert.match(architect, /Source allowlisting/);
assert.match(architect, /Deduplication/);
assert.match(architect, /Safety classification/);
assert.match(architect, /LIVE OPERATIONS CENTER/);
assert.match(architect, /показываются только реальные данные Controller/);
assert.match(architect, /function nodeHealth/);
assert.match(architect, /function showOperationsBrief/);
assert.match(architect, /lt\("Здоровье","Health","בריאות"\)/);
assert.match(architect, /detail-toggle/);
assert.match(architect, /\/api\/v1\/architect\/work-roles/);
assert.doesNotMatch(architect, /Последние события аудита/);
assert.match(architect, /\/api\/v1\/architect\/security\/recover-token/);
assert.match(architect, /Аварийное восстановление \/ сброс доступа/);
assert.match(architect, /Выполнить аварийный сброс доступа/);
assert.match(architect, /id="homeButton"[^>]+href="\/"/);
assert.match(architect, /home:"Главная"/);
assert.match(architect, /home:"Home"/);
assert.match(architect, /home:"בית"/);
assert.match(architect, /\/api\/v1\/architect\/enterprise/);
assert.match(architect, /\/api\/v1\/architect\/security\/access-tokens/);
assert.match(architect, /Desired State \/ Policy Engine/);
assert.match(architect, /Windows Event Log/);
assert.match(architect, /CIM \/ Performance Counters/);
assert.match(architect, /gMSA \/ dMSA/);
assert.match(architect, /Windows Update \/ Hotpatch/);
assert.match(architect, /Hyper-V/);
assert.match(architect, /GPO \/ Intune \/ MDM/);
assert.match(architect, /Sites \/ Node Groups/);
assert.match(architect, /recovery-manifest/);
assert.match(index, /architectEnterpriseOverview/);
assert.match(index, /architectCreateAccessToken/);
assert.match(index, /architectSetEnterprisePolicy/);
assert.match(index, /architectEnterpriseRecoveryManifest/);
assert.match(index, /requiredArchitectPermission/);
assert.match(index, /commands\.active_duplicates_repaired/);
assert.match(index, /keep_newest_active_per_node/);
assert.doesNotMatch(index, /command_type\s*[:=]\s*["']shell["']/);
assert.match(index, /async function architectNodeDetails/);
assert.ok(index.includes("/details$"), "node details route missing");
for (const required of [
  'id="nodeDialog"',
  'id="nodeNetwork"',
  'id="nodeAi"',
  'id="lmInstall"',
  'id="workerTarget"',
  'id="lmProbe"',
  'id="lmRemove"',
  'id="modelId"',
  'id="modelGet"',
  'id="modelLoad"',
  'id="detailWake"',
  'id="detailRestart"',
  'id="detailStop"',
  'id="detailRollback"',
  'id="detailReboot"',
  'id="detailShutdown"',
  'id="detailUninstall"',
  "/details",
  "LAN IP",
  "MAC",
  "lmstudio_install",
  "lmstudio_probe",
  "lmstudio_model_get",
  "lmstudio_model_load",
  "system_reboot",
  "system_shutdown",
  "active||fleetOperation?10000:60000"
]) {
  assert.ok(operations.includes(required), "Operations capability missing: " + required);
}
assert.ok(!operations.includes("setInterval(refresh,10000)"), "Operations console must not poll every 10 seconds");
for (const required of [
  'id="selectLmAll"',
  'id="installLmSelected"',
  'id="fleetActivity"',
  'id="modelResults"',
  'id="modelDetailsDialog"',
  "ai-badge",
  "lmstudio-preflight",
  "/models/details",
  "&limit=80",
  "showModelDetails",
  "selectedNodeIds",
  "updateFleetActivityFromData"
]) {
  assert.ok(operations.includes(required), "LM Studio fleet/model UX missing: " + required);
}
for (const required of [
  "function updateCommandFeedback",
  "удалённый агент подтвердил получение",
  "проверяет SHA-256 и self-check",
  "локальную фазу и проверку файлов",
  "Обновление подтверждено heartbeat",
  "без heartbeat >5 мин",
  "heartbeat новой версии подтверждён"
]) {
  assert.ok(operations.includes(required), "agent update proof UX missing: " + required);
}
for (const required of [
  'id="nodeQueryStop"',
  "async function cancelNodeQuery",
  "■ Стоп LM Studio",
  "/cancel",
  "agent_version,'0.3.39'",
  "stopSupported=lmInstalled&&sshVersionAtLeast(n.agent_version,'0.3.39')",
  "$('nodeQueryStop').hidden=!stopSupported"
]) {
  assert.ok(operations.includes(required), "LM Studio query Stop UX missing: " + required);
}
for (const required of [
  'id="hybridStop"',
  "async function stopHybrid",
  "■ Стоп LM Studio",
  "/cancel",
  "agent_version,'0.3.39'",
  "$('hybridStop').hidden=!stopSupported",
  "lmstudio_installed||0"
]) {
  assert.ok(hub.includes(required), "Hub LM Studio query Stop UX missing: " + required);
}
for (const required of [
  "async function architectCancelCommand",
  "async function nodeCommandCancelState",
  "command.cancel_requested",
  "cancel-state",
  '"cancelled"'
]) {
  assert.ok(index.includes(required), "Controller query cancellation missing: " + required);
}
for (const required of [
  "class OperationCancelled",
  "command_cancel_requested",
  "cancel-state",
  "cancellable=True",
  'ack_command(command_id, "cancelled")'
]) {
  assert.ok(agent.includes(required), "Agent query cancellation missing: " + required);
}
for (const required of [
  "architectModelDetails",
  "architectLmstudioPreflight",
  "ai_installed",
  "lmstudio_command_storage_unavailable",
  "modelNodeCompatibility",
  "/models/details"
]) {
  assert.ok(index.includes(required), "LM Studio fleet/model API missing: " + required);
}


assert.match(architect, /Ноды, проекты, миссии, отчёты, модели и данные не удаляются/);
assert.match(architect, /\/api\/v1\/architect\/security\/recovery-code/);
assert.match(architect, /\/api\/v1\/architect\/security\/rotate-token/);
assert.match(index, /architectRecoverToken/);
assert.match(index, /architectRotateToken/);
assert.match(index, /architectCreateRecoveryCode/);
assert.match(index, /architect_auth_state/);
assert.match(index, /architect_recovery_attempts/);
assert.match(index, /old_token_invalidated: true/);
assert.match(index, /recovery_code_consumed: true/);
assert.doesNotMatch(index, /current-token/);
assert.doesNotMatch(architect, /Показать текущий токен/);

assert.match(index, /"restart", "stop", "rollback"/);
assert.match(index, /stop: "offline"/);
assert.match(index, /agent_update_required/);
assert.match(index, /throw new ApiError\(409, "node_offline"\)/);
assert.match(index, /throw new ApiError\(409, "node_paused"\)/);
assert.match(architect, /node\.agent_version !== currentReleaseVersion/);
assert.match(architect, /function latestAgentUpdateCommand/);
assert.match(architect, /function renderAgentUpdateProgress/);
assert.match(architect, /command\?\.status === "pending"/);
assert.match(architect, /command\?\.status === "accepted"/);
assert.match(architect, /command\?\.status === "completed"/);
assert.match(architect, /command\?\.status === "failed"/);
assert.match(architect, /новая версия подтверждена heartbeat/);
assert.match(architect, /Это этапный индикатор Controller, а не измерение загруженных байтов/);
assert.match(index, /task_text: taskText/);
assert.match(index, /mission_types: \["system_inventory"\]/);
assert.match(index, /source_allowlisting/);
assert.match(index, /deduplication/);
assert.match(index, /safety_classification/);
assert.match(index, /agent_rollouts/);
assert.match(index, /ensureRolloutCommandForNode/);
assert.match(index, /architect_projects/);
assert.match(index, /project_work_items/);
assert.match(index, /project_specializations/);
assert.match(index, /architectGetProject/);
assert.match(index, /normalizeRequestedProjectRoles/);
assert.match(index, /normalizeProjectWorkerTarget/);
assert.match(index, /targetProjectWork/);
assert.match(operations, /value="50"/);
assert.match(operations, /value="all"/);
assert.match(index, /final_report_ready/);
assert.match(index, /worker_readiness/);
assert.match(index, /ready_workers_now/);
assert.match(index, /materializeProjectWorkForNode\(env, worker\.node_id, projectId\)/);
assert.match(architect, /projectStageTrack/);
assert.match(architect, /projectWorkerReadiness/);
assert.match(architect, /PLAN/);
assert.match(architect, /WAITING MODEL/);
assert.match(architect, /Подготовить ноду в Hub/);
assert.match(architect, /sessionStorage\.setItem\("citadel-lmnode-request"/);
assert.match(architect, /location\.href = "\/hub\/"|location\.href="\/hub\/"|location\.href = '\/hub\/'/);
assert.match(architect, /ASSIGNED/);
assert.match(architect, /RUNNING/);
assert.match(architect, /COMPLETED/);
assert.match(architect, /REPORT/);
assert.match(architect, /agent_outdated/);
assert.match(architect, /lmstudio_model_not_loaded/);
assert.match(index, /materializeProjectWorkForNode/);
assert.match(index, /current\.command_type === "lmstudio_model_load"/);
assert.match(index, /project_assignments_created/);
assert.match(index, /mission_type, payload_json/);
assert.match(index, /missionType = executionMode === "python" \? "project_python" : "project_text"/);
assert.match(index, /waiting_for_lmstudio_project_worker/);
assert.match(index, /architect_python/);
assert.match(architect, /projectExecutionMode/);
assert.match(index, /project_python/);
assert.match(index, /waiting_for_python_project_worker/);
assert.match(index, /not_applicable_python/);
{
  const hybridStart = index.indexOf('} else if (commandType === "hybrid_query") {');
  assert.ok(hybridStart >= 0, "hybrid_query Controller branch missing");
  const hybridBlock = index.slice(hybridStart, hybridStart + 1800);
  assert.match(hybridBlock, /if \(mode !== "python"\)/);
  assert.ok(
    hybridBlock.indexOf('if (mode !== "python")') < hybridBlock.indexOf('ensureNodeAiStorage(env)'),
    "Python-only hybrid query must not require LM Studio AI-state storage"
  );
}
assert.match(index, /executionMode === "python"/);
assert.match(architect, /Python only · без ИИ/);
assert.match(architect, /WAITING PYTHON/);
assert.match(architect, /project_python/);
assert.match(agent, /execute_project_python/);
assert.match(agent, /"project_python" in agent\.capabilities/);
assert.match(agent, /Python-only mode: no AI\/LLM was called/);
assert.match(index, /lmstudio_uninstall/);
assert.match(index, /REMOVE_LMSTUDIO/);
assert.match(agent, /def uninstall_lmstudio/);
assert.match(agent, /def validate_lmstudio_uninstall_payload/);
assert.match(hub, /id="lmstudioUninstall"/);
assert.match(hub, /id="lmstudioPurgeData"/);
assert.match(hub, /REMOVE_LMSTUDIO/);
assert.match(hub, /Python \/ AI executor/);
assert.match(hub, /data-hybrid-mode="python"/);
assert.match(architect, /\.section-collapsed-child\{display:none!important\}/);
assert.match(architect, /id="projectPreflight"/);
assert.match(architect, /id="projectTaskLogs"/);
assert.match(architect, /Логи этого задания/);
assert.doesNotMatch(home, /href="\/architect\/logs\/" /);
assert.doesNotMatch(hub, /href="\/architect\/logs\/" /);
assert.match(index, /function projectTextPreflight/);
assert.match(index, /text_preflight/);
assert.match(index, /task_logs: taskLogs/);
assert.match(agent, /python_mini_agent_tasks/);
assert.match(agent, /ThreadPoolExecutor/);
assert.match(agent, /mini_agent_count/);
assert.match(agent, /current_hash == item\["sha256"\]/);
assert.match(agent, /agent_update_noop/);
assert.match(agent, /CITADEL_LMSTUDIO_HOME/);
assert.match(index, /openrouter:/);

for (const [name, page] of [["home", home], ["hub", hub], ["architect", architect], ["logs", logs]]) {
  assert.match(page, /id="homeButton"/, `${name} view must expose a Home button`);
}
assert.match(hub, /history\.replaceState\(\{citadelView:"hub"\},"","\/"\)/);
assert.match(architect, /history\.replaceState\(\{citadelView:"architect"\},"","\/"\)/);
assert.match(logs, /history\.replaceState\(\{citadelView:"logs"\},"","\/"\)/);
assert.match(home, /href="\/hub\/" /);
assert.match(home, /href="\/architect\/" /);
assert.doesNotMatch(home, /href="\/architect\/logs\/" /);
assert.doesNotMatch(home, /document\.write\(/);
assert.doesNotMatch(hub, /document\.write\(/);
assert.doesNotMatch(architect, /document\.write\(/);
assert.match(architect, /sessionStorage\.setItem\("citadel-lmnode-request"/);
{
  const start = index.indexOf("async function publicHubNodes");
  const end = index.indexOf("async function architectRelease", start);
  assert.ok(start >= 0 && end > start, "publicHubNodes function missing");
  const publicHubBlock = index.slice(start, end);
  assert.doesNotMatch(
    publicHubBlock,
    /ensureAutoEnrollmentStorage/,
    "public Hub GET path must remain read-only and must not run schema DDL"
  );
  assert.match(publicHubBlock, /SELECT node_id, agent_version, status, enrolled_at, last_seen_at/);
  assert.match(publicHubBlock, /FROM nodes WHERE status != 'revoked' LIMIT 500/);
  assert.match(publicHubBlock, /cache-control/);
  assert.doesNotMatch(publicHubBlock, /node_numbers/);
  assert.doesNotMatch(publicHubBlock, /sqlite_master/);
}
assert.match(autoEnrollmentMigration, /CREATE TABLE IF NOT EXISTS node_numbers/);
assert.match(autoEnrollmentMigration, /CREATE TABLE IF NOT EXISTS auto_enrollment_windows/);
assert.doesNotMatch(deployWorkflow, /wrangler d1 execute/);
assert.match(index, /function publicHubQueryErrorCode/);
assert.match(index, /hub_d1_daily_read_limit_exceeded/);
assert.match(index, /hub_d1_daily_write_limit_exceeded/);
assert.match(index, /\/api\/v1\/status\/d1-usage/);
assert.match(index, /d1UsageStatus\(env\)/);
assert.ok(operations.includes("fetch('/api/v1/status/d1-usage'"), "D1 meter must not depend on Architect D1 authentication");
assert.ok(!operations.includes("api('/d1-usage')"), "D1 meter must not call the D1-backed Architect auth route");
assert.match(index, /hub_d1_overloaded/);
{
  const start = index.indexOf("async function architectOverview");
  const end = index.indexOf("function publicHubQueryErrorCode", start);
  assert.ok(start >= 0 && end > start, "architectOverview function missing");
  const overviewBlock = index.slice(start, end);
  assert.doesNotMatch(overviewBlock, /backfillLegacyReports\(env\)/);
}
assert.match(hub, /setInterval\(refresh,60000\)/);
assert.doesNotMatch(home, /setInterval\(refresh,10000\)/);
assert.match(home, /const PUBLIC_HUB_REFRESH_MS=300000;/);
assert.match(home, /function scheduleRefresh\(delay=PUBLIC_HUB_REFRESH_MS\)/);
assert.match(home, /async function refresh\(\)\{\s*if\(document\.hidden\)/);
assert.match(home, /visibilitychange/);
assert.match(home, /if\(!document\.hidden\)scheduleRefresh\(delay\)/);
assert.match(home, /healthFetchedAt>=300000/);
assert.match(home, /hub_d1_daily_read_limit_exceeded/);
assert.match(home, /nextUtcReset/);
assert.match(index, /idx_project_work_items_status_project_created/);
assert.match(index, /idx_nodes_status_last_seen/);
assert.match(index, /idx_audit_events_created_action/);
assert.match(architect, /\}, 60000\);/);
assert.match(index, /function operationalNodeState/);
assert.match(index, /function isTestNodeRecord/);
assert.match(index, /async function expireStaleCommands/);
assert.match(index, /await expireStaleCommands\(env\)/);
assert.match(index, /command\.expired/);
assert.match(index, /test_node_excluded/);
assert.match(index, /lmstudio_state_unknown/);
assert.match(index, /lmstudio_state_updated_at/);
assert.match(architect, /lmstudio_state_unknown/);
assert.match(architect, /Проект сохранён и ждёт/);
{
  const start = index.indexOf("async function architectCreateProject");
  const end = index.indexOf("async function architectListProjects", start);
  assert.ok(start >= 0 && end > start, "architectCreateProject function missing");
  const createProjectBlock = index.slice(start, end);
  assert.doesNotMatch(createProjectBlock, /throw new ApiError\(409, "no_available_nodes"\)/);
  assert.doesNotMatch(createProjectBlock, /throw new ApiError\(409, "no_ready_workers_check_agent_and_loaded_model"\)/);
  assert.match(createProjectBlock, /hub_plan_saved_waiting_for_ready_lmstudio_worker/);
}
assert.match(index, /compliance_in_scope/);
assert.match(index, /nodes_updateable_now/);
assert.match(architect, /function nodeOperationalState/);
assert.match(architect, /function nodeInOperationalScope/);
assert.match(architect, /expired \(TTL\)/);
assert.match(architect, /Excluded stale\/test\/history/);
assert.match(architect, /ВНЕ ACTIVE SCOPE/);
assert.match(architect, /Тестовые ноды не участвуют/);
assert.match(index, /final_report:/);
assert.match(agent, /execute_project_text/);
assert.match(agent, /127\.0\.0\.1/);
assert.match(agent, /\/v1\/chat\/completions/);
assert.match(agent, /"project_text" in agent\.capabilities/);
assert.doesNotMatch(agent, /shell=True/);
assert.match(index, /WORK_ROLE_REGISTRY/);
assert.match(index, /legacy_simulation/);
assert.match(index, /"programmer"/);
assert.match(index, /"mathematician"/);
assert.match(index, /role_name TEXT NOT NULL DEFAULT 'planner'/);
assert.match(index, /architectWorkRoles/);
assert.match(index, /AS planned_role/);
assert.match(architect, /node\.planned_role/);
assert.match(architect, /lt\("Роль","Role","תפקיד"\)/);
assert.doesNotMatch(index, /audit_events: auditQuery/);
assert.match(agent, /"restart", "stop", "rollback"/);
for (const command of ["pause", "resume", "update", "restart", "stop", "rollback"]) {
  assert.match(agent, new RegExp(`command_type == "${command}"`), `agent handler missing: ${command}`);
}
assert.match(agent, /command_type in \{"system_reboot", "system_shutdown"\}/);
assert.match(agent, /wake_peer/);
assert.match(agent, /schedule_system_power_action/);
assert.match(agent, /agent_stop_requested/);
assert.doesNotMatch(agent, /command_type == "shell"/);
assert.match(architect, /\/api\/v1\/architect\/nodes\/\$\{encodeURIComponent\(node\.node_id\)\}\/wake/);
assert.match(index, /architectWakeNode/);
assert.match(index, /wake_peer/);
assert.match(index, /node_network_state/);
assert.match(agent, /command_type == "wake_peer"/);
assert.match(agent, /send_wake_packet/);
assert.match(agent, /mac_addresses/);
assert.doesNotMatch(agent, /command_type == "shell"/);

console.log("Architect UX regression guards: PASS");


assert.match(architect, /id="openOperationsBrief"/);
assert.match(architect, /function dismissOperationsBrief/);
assert.match(architect, /event\.target === operationsAlert/);
assert.match(architect, /event\.key !== "Escape"/);
assert.doesNotMatch(architect, /if \(!openingBriefShown\) showOperationsBrief\(data\.nodes \|\| \[\]\)/);
assert.match(architect, /PLAN \/ WAITING/);
assert.match(architect, /Controller покажет READY-ноды и точный blocker/);


// Behavioral guard: a valid AI project is durable even when no execution-ready
// worker exists at creation time. This exercises the HTTP handler instead of
// relying only on source-string assertions above.
{
  const workerModule = await import(new URL("../src/index.js", import.meta.url));
  const projectWorker = workerModule.default;
  const architectToken = "test-architect-token-with-enough-entropy";
  const architectHash = Buffer.from(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(architectToken)
  )).toString("hex");
  const persisted = { project: null, workItems: 0, workTaskPointers: [], payloadObjects: 0 };
  const originalFetch = globalThis.fetch;
  let driveUploadNo = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
      driveUploadNo += 1;
      return new Response(JSON.stringify({
        id: "drive_test_" + driveUploadNo,
        name: "payload.json",
        size: String((init.body || "").length)
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return originalFetch(input, init);
  };

  function compactSql(sql) {
    return sql.replace(/\s+/g, " ").trim();
  }

  class ProjectStatement {
    constructor(sql) {
      this.sql = compactSql(sql);
      this.args = [];
    }
    bind(...args) {
      this.args = args;
      return this;
    }
    async first() {
      if (this.sql.includes("FROM architect_auth_state WHERE singleton_id = 1")) {
        return {
          token_hash: architectHash,
          bootstrap_mode: 0,
          recovery_hash: null,
          recovery_used: 1,
          token_rotated_at: null,
          recovery_created_at: null,
          updated_at: new Date().toISOString()
        };
      }
      if (
        this.sql.includes("SELECT project_id, status FROM architect_projects") &&
        this.sql.includes("task_sha256 = ?")
      ) {
        return null;
      }
      throw new Error(`Unhandled project first(): ${this.sql}`);
    }
    async all() {
      if (
        this.sql.includes("FROM nodes AS n") &&
        this.sql.includes("WHERE n.status = 'online'")
      ) {
        return { results: [] };
      }
      throw new Error(`Unhandled project all(): ${this.sql}`);
    }
    async run() {
      if (this.sql.startsWith("CREATE TABLE") || this.sql.startsWith("CREATE INDEX") || this.sql.startsWith("CREATE UNIQUE INDEX")) {
        return { meta: { changes: 0 } };
      }
      if (
        this.sql.startsWith("INSERT OR IGNORE INTO architect_auth_state") ||
        this.sql.startsWith("INSERT OR IGNORE INTO project_assignment_recovery_gate")
      ) {
        return { meta: { changes: 0 } };
      }
      if (this.sql.startsWith("INSERT INTO architect_projects")) {
        persisted.project = {
          project_id: this.args[0],
          task_text: this.args[3],
          worker_count: this.args[this.args.length - 1]
        };
        return { meta: { changes: 1 } };
      }
      if (this.sql.startsWith("INSERT INTO project_work_items")) {
        persisted.workItems += 1;
        persisted.workTaskPointers.push(this.args[5]);
        return { meta: { changes: 1 } };
      }
      if (this.sql.startsWith("INSERT INTO payload_objects")) {
        persisted.payloadObjects += 1;
        return { meta: { changes: 1 } };
      }
      if (
        this.sql.startsWith("INSERT INTO project_specializations") ||
        this.sql.startsWith("INSERT INTO audit_events")
      ) {
        return { meta: { changes: 1 } };
      }
      throw new Error(`Unhandled project run(): ${this.sql}`);
    }
  }

  const projectEnv = {
    ARCHITECT_TOKEN_HASH: architectHash,
    GOOGLE_DRIVE_ACCESS_TOKEN: "test-drive-token",
    DB: {
      prepare(sql) {
        return new ProjectStatement(sql);
      },
      async batch(statements) {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      }
    },
    ASSETS: { fetch() { return new Response("asset"); } }
  };

  try {
    const response = await projectWorker.fetch(new Request(
    "https://example.test/api/v1/architect/projects",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${architectToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        source_type: "architect_manual",
        title: "Waiting-worker behavior",
        task_text: "Explain why bounded queues should not starve compatible work.",
        worker_target: 10
      })
    }
  ), projectEnv);

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.project.worker_count, 0);
  assert.equal(body.project.desired_workers, 10);
  assert.equal(body.project.worker_target.mode, "fixed");
  assert.equal(body.execution.detail, "hub_plan_saved_waiting_for_ready_lmstudio_worker");
  assert.equal(body.project.work_item_count, 10);
  assert.equal(persisted.project?.worker_count, 0);
    assert.equal(persisted.workItems, body.project.work_item_count);
    assert.ok(body.project.work_items.every((item) => item.node_id === null));
    assert.match(persisted.project.task_text, /^@drive:payload_/);
    assert.ok(persisted.workTaskPointers.every((value) => /^@drive:payload_/.test(value)));
    assert.ok(persisted.payloadObjects >= 2, "project payloads must be indexed, not stored inline");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

assert.match(operations, /<option value="1" selected>1<\/option>/);
assert.match(operations, /Задание сохранено\. Оно ждёт готовую ноду\/модель/);
assert.match(index, /function agentVersionAtLeast/);
assert.match(index, /qualityGate\.content \|\| rawResultText/);
assert.match(index, /local_result_ready_quality_gate_running/);

assert.match(operations, /id="updateAll"/);
assert.match(operations, /id="rollbackAll"/);
assert.match(operations, /id="clock"/);
assert.match(operations, /async function bulkCommand\(type\)/);
assert.match(operations, /class="node-grid"/);
assert.match(operations, /Автообновить все/);
assert.match(operations, /Откатить все/);

assert.match(index, /ensureAutoEnrollmentStorage\(env\).*nodesQuery/s);
assert.match(index, /ensureReportStorage\(env\),\s*ensureAutoEnrollmentStorage\(env\)/);
assert.match(operations, /Сервер не смог собрать сведения проекта/);

assert.match(operations, /id="lmUpdate"/);
assert.match(operations, /Обновить LM Studio/);
assert.match(operations, /🖥️/);
assert.match(operations, /id="lmLiveStatus"/);
assert.match(operations, /startDetailProgressWatch/);
assert.match(operations, /waiting_agent/);
assert.match(operations, /active\|\|fleetOperation\?10000:60000/);
assert.match(operations, /Официальный установщик LM Studio сейчас работает/);

{
  const listStart = index.indexOf("async function architectListProjects");
  const listEnd = index.indexOf("async function architectGetProject", listStart);
  assert.ok(listStart >= 0 && listEnd > listStart, "architect project list function missing");
  const listBlock = index.slice(listStart, listEnd);
  assert.ok(listBlock.includes("architectProjectListRows(env)"), "project list must read before bootstrap");
  assert.ok(!listBlock.includes("expireStalePlannedProjects"), "project GET must not run cleanup writes");
  assert.ok(
    listBlock.indexOf("architectProjectListRows(env)") < listBlock.indexOf("ensureProjectStorage(env)"),
    "project GET may bootstrap only after a missing-table read failure"
  );

  const rowsStart = index.indexOf("async function architectProjectListRows");
  const rowsEnd = index.indexOf("async function architectListProjects", rowsStart);
  const rowsBlock = index.slice(rowsStart, rowsEnd);
  assert.match(rowsBlock, /WITH recent_projects AS/);
  assert.match(rowsBlock, /LEFT JOIN project_work_items AS w/);
  assert.doesNotMatch(rowsBlock, /\(SELECT COUNT\(\*\) FROM project_work_items/);
}
assert.ok(operations.includes("Date.now()-lastProjectsAt>300000"), "idle project polling must be throttled");
assert.ok(operations.includes("needProjects?api('/projects'"), "active project polling must remain live");
assert.ok(operations.includes("сохраняются, пока не появится подходящий исполнитель"), "project retention copy must match durable queue behavior");
assert.ok(operations.includes("aiLive=aiRunning&&['online','paused'].includes(n.status)"), "AI LIVE badge must require a live/paused node");
assert.ok(operations.includes("✦ AI · последнее состояние"), "offline nodes must label stale AI state explicitly");

assert.ok(operations.includes("Promise.allSettled([api('/machines'"), "partial refresh must use allSettled");
assert.ok(operations.includes("Часть данных не обновлена"), "partial refresh warning missing");
assert.ok(operations.includes("refreshErrorText"), "refresh error mapper missing");

assert.ok(operations.includes("lmInstall').hidden=lmInstalled||lmBusy"), "LM Studio install control must hide after install");
assert.ok(operations.includes("lmUpdate').hidden=!lmInstalled||lmBusy"), "LM Studio update control must require install");
assert.ok(operations.includes("lmRemove').hidden=!lmInstalled||lmBusy"), "LM Studio remove control must require install");
assert.ok(operations.includes("modelGet').hidden=!lmInstalled"), "model actions must hide until LM Studio is installed");
assert.ok(operations.includes("LM Studio установлен — доступны обновление"), "dynamic LM Studio hint missing");

for (const required of [
  'id="sshDialog"',
  'id="sshHost"',
  'id="sshUser"',
  'id="sshFingerprint"',
  'id="sshProbe"',
  'id="sshOpen"',
  'id="sshInlineOutput"',
  'id="sshInlineInput"',
  'id="sshInlineSend"',
  "loadOperationsSshState",
  "saveOperationsSshState",
  "sendOperationsSshCommand",
  "command_type:'ssh_console'",
  "command_type:'ssh_probe'",
  "sshSelectionGeneration",
  "sshDirtyFields"
]) {
  assert.ok(operations.includes(required), "deployed Machines SSH UX missing: " + required);
}
assert.ok(!operations.includes('<a href="/hub/">Открыть Hub SSH</a>'), "deployed SSH UI must not redirect to retired Hub route");
assert.ok(operations.includes("sshVersionAtLeast(node.agent_version,'0.3.32')"), "deployed restricted terminal must require agent 0.3.32+");
assert.ok(operations.includes("if(Array.isArray(node?.capabilities))return node.capabilities;"), "deployed SSH bootstrap must use detailed node capabilities");
assert.ok(operations.includes("if(currentNode?.node_id===sshNodeId)return currentNode;"), "deployed SSH must prefer detailed selected-node state");
assert.ok(operations.includes("^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$"), "deployed SSH hostname validation must match Controller");
assert.ok(operations.includes("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"), "deployed SSH user validation must match Controller");
assert.ok(operations.includes("^SHA256:[A-Za-z0-9+/=]{20,120}$"), "deployed SSH fingerprint validation must match Controller");
assert.ok(operations.includes("sshInlineGeneration") && operations.includes("sshProbeGeneration"), "deployed SSH async work must be bound to dialog generations");
assert.ok(operations.includes("async function waitForOperationsSshProbe"), "deployed SSH probe must poll queued command completion");
assert.ok(operations.includes("sshSelectionGeneration===selectionGeneration&&sshInlineGeneration===inlineGeneration"), "deployed SSH terminal must reject earlier dialog-session polls");
assert.ok(operations.includes("sshSelectionGeneration===selectionGeneration&&sshProbeGeneration===probeGeneration"), "deployed SSH probe must reject earlier dialog-session polls");
assert.ok(operations.includes("host===savedHost&&user===savedUser"), "Browser SSH must require saved hostname/user");
assert.ok(operations.includes("sshPendingProbeCommands=new Map()") && operations.includes("sshPendingInlineCommands=new Map()"), "pending SSH command IDs must be retained");
const sshProbeStore = operations.indexOf("pending={commandId};sshPendingProbeCommands.set(nodeId,pending);");
const sshProbeGuard = operations.indexOf("if(!$('sshDialog').open||sshNodeId!==nodeId", sshProbeStore);
assert.ok(sshProbeStore >= 0 && sshProbeGuard > sshProbeStore, "probe command ID must be retained before dialog-session guard");
const sshInlineStore = operations.indexOf("active={commandId,verb};sshPendingInlineCommands.set(nodeId,active);");
const sshInlineGuard = operations.indexOf("if(!current())return;", sshInlineStore);
assert.ok(sshInlineStore >= 0 && sshInlineGuard > sshInlineStore, "terminal command ID must be retained before dialog-session guard");
assert.ok(operations.includes("command ID retained") && operations.includes("Получить результат"), "pending terminal commands need a resumable retrieval path");
assert.ok(operations.includes("withButton('sshProbe',probeOperationsSsh).finally(()=>renderOperationsSshState())"), "probe retrieval label must be restored after withButton cleanup");
assert.ok(operations.includes("formatSshCommandResult(command)"), "failed SSH command output must be rendered");
assert.ok(operations.includes("if($('sshDialog').open&&sshNodeId===n.node_id)renderOperationsSshState()"), "SSH bootstrap eligibility must refresh after node details load");


assert.ok(index.includes("CREATE TABLE IF NOT EXISTS commands"), "runtime command table bootstrap missing");
assert.ok(index.includes("CREATE TABLE IF NOT EXISTS audit_events"), "runtime audit table bootstrap missing");
assert.ok(index.includes("lmstudio_command_storage_unavailable"), "LM Studio command storage error mapping missing");

assert.ok(index.includes('id: "engineer"'), "Engineer profession missing");
assert.ok(index.includes('id: "scientist"'), "Scientist profession missing");
assert.ok(operations.includes('id="professionFab"'), "floating profession picker missing");
assert.ok(operations.includes('requested_roles:[...selectedProfessionIds]'), "selected professions must be submitted");
assert.ok(index.includes('DEFAULT_GOOGLE_DRIVE_PAYLOAD_FOLDER_ID'), "Google Drive payload store missing");
assert.ok(index.includes('CREATE TABLE IF NOT EXISTS payload_objects'), "minimal payload index missing");
assert.ok(index.includes('DRIVE_POINTER_PREFIX = "@drive:"'), "Drive pointer format missing");
assert.ok(index.includes('task_payload_id'), "mission payload must reference Drive task payload");
assert.ok(index.includes('async function architectGetInteractiveThread'), "interactive report GET missing");
assert.ok(index.includes('async function architectPostInteractiveMessage'), "interactive report POST missing");
assert.ok(index.includes('preferred_node_id') && index.includes('interactive_followup'), "interactive work must preserve worker affinity");
assert.ok(operations.includes('id="reportReplyForm"'), "interactive report composer missing");
assert.ok(operations.includes('Продолжение уйдёт тому же EE'), "same-worker interactive report hint missing");
assert.ok(deployWorkflow.includes("GOOGLE_DRIVE_REFRESH_TOKEN"), "Drive credentials deploy wiring missing");
