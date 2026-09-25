import fs from "node:fs";
import assert from "node:assert/strict";

const architect = fs.readFileSync("architect.html", "utf8");
const hub = fs.readFileSync("hub.html", "utf8");
const logs = fs.readFileSync("architect-logs.html", "utf8");
const home = fs.readFileSync("live-index.html", "utf8");
const index = fs.readFileSync("src/index.js", "utf8");
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
assert.doesNotMatch(index, /command_type\s*[:=]\s*["']shell["']/);

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
assert.match(home, /function scheduleRefresh\(delay=60000\)/);
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
