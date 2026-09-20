import fs from "node:fs";
import assert from "node:assert/strict";

const architect = fs.readFileSync("architect.html", "utf8");
const index = fs.readFileSync("src/index.js", "utf8");
const agent = fs.readFileSync("agent/citadel_node_v1.py", "utf8");

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
  "homeButton"
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
assert.match(architect, /\/hub\/\?lmnode=/);
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
assert.match(index, /'project_text'/);
assert.match(index, /waiting_for_lmstudio_project_worker/);
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
