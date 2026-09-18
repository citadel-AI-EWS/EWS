import fs from "node:fs";
import assert from "node:assert/strict";

const architect = fs.readFileSync("architect.html", "utf8");
const index = fs.readFileSync("src/index.js", "utf8");
const agent = fs.readFileSync("agent/citadel_node_v1.py", "utf8");

assert.match(
  architect,
  /<section class="card hidden" aria-hidden="true">[\s\S]*?<h2>Контрольные точки<\/h2>/,
  "obsolete checkpoint panel must stay hidden"
);
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
  "workRoles"
]) {
  assert.match(architect, new RegExp(`id="${id}"`), `Architect control missing: ${id}`);
}
assert.match(architect, /\/api\/v1\/architect\/presence/);
assert.match(architect, /createInventoryMission/);
assert.match(architect, /task_text:/);
assert.match(architect, /Диагностика системы/);
assert.match(architect, /System Inventory — это техническая диагностика узла/);
assert.match(architect, /cloudflared access ssh --hostname %h/);
assert.match(architect, /sendControl\("stop"\)/);
assert.match(architect, /sendControl\("system_reboot", "REBOOT"\)/);
assert.match(architect, /sendControl\("system_shutdown", "SHUTDOWN"\)/);
assert.match(architect, /\/api\/v1\/architect\/update-all/);
assert.match(architect, /\/api\/v1\/architect\/projects\/check/);
assert.match(architect, /\/api\/v1\/architect\/projects/);
assert.match(architect, /Source allowlisting/);
assert.match(architect, /Deduplication/);
assert.match(architect, /Safety classification/);
assert.match(architect, /LIVE OPERATIONS CENTER/);
assert.match(architect, /показываются только реальные данные Controller/);
assert.match(architect, /function nodeHealth/);
assert.match(architect, /function showOperationsBrief/);
assert.match(architect, /Здоровье:/);
assert.match(architect, /detail-toggle/);
assert.match(architect, /\/api\/v1\/architect\/work-roles/);
assert.doesNotMatch(architect, /Последние события аудита/);

assert.match(index, /"restart", "stop", "rollback"/);
assert.match(index, /stop: "offline"/);
assert.match(index, /agent_update_required/);
assert.match(architect, /node\.agent_version !== currentReleaseVersion/);
assert.match(index, /task_text: taskText/);
assert.match(index, /mission_types: \["system_inventory"\]/);
assert.match(index, /source_allowlisting/);
assert.match(index, /deduplication/);
assert.match(index, /safety_classification/);
assert.match(index, /agent_rollouts/);
assert.match(index, /ensureRolloutCommandForNode/);
assert.match(index, /architect_projects/);
assert.match(index, /project_work_items/);
assert.match(index, /WORK_ROLE_REGISTRY/);
assert.match(index, /legacy_simulation/);
assert.match(index, /"programmer"/);
assert.match(index, /"mathematician"/);
assert.match(index, /role_name TEXT NOT NULL DEFAULT 'planner'/);
assert.match(index, /architectWorkRoles/);
assert.match(index, /AS planned_role/);
assert.match(architect, /Роль: \$\{node\.planned_role \|\| "не назначена"\}/);
assert.doesNotMatch(index, /audit_events: auditQuery/);
assert.match(agent, /"restart", "stop", "rollback"/);
assert.match(agent, /elif command_type == "stop":/);
assert.match(agent, /agent_stop_requested/);
assert.doesNotMatch(agent, /command_type == "shell"/);

console.log("Architect UX regression guards: PASS");
