import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const guardian = readFileSync(new URL("../src/d1-guardian.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const operations = readFileSync(new URL("../operations.html", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/0019_d1_guardian.sql", import.meta.url), "utf8");

assert.match(wrangler, /"\*\/5 \* \* \* \*"/, "Guardian cron must run every five minutes");
assert.match(worker, /runD1Guardian\(env/, "scheduled Worker must invoke D1 Guardian");
assert.match(worker, /controller\?\.cron === "\*\/5 \* \* \* \*"/, "Guardian cron must be isolated from hourly telemetry cleanup");
assert.match(worker, /controller\?\.cron === "17 \* \* \* \*"/, "existing hourly telemetry retention must remain");

assert.match(guardian, /GUARDIAN_BATCH_LIMIT = 50/, "repair batches must stay bounded");
assert.match(guardian, /GUARDIAN_ACTION_LIMIT = 200/, "Guardian history must stay bounded");
assert.match(guardian, /LIMIT \?/, "repair queries must use explicit limits");
assert.match(guardian, /stale_nodes_offline/, "stale node repair missing");
assert.match(guardian, /stale_commands_expired/, "stale command repair missing");
assert.match(guardian, /stale_project_assignments_requeued/, "stale assignment recovery missing");
assert.match(guardian, /expireStaleCommands\(env, null, GUARDIAN_BATCH_LIMIT\)/,
  "Guardian command expiry must use the 50-row repair cap");
assert.match(guardian, /recoverStaleProjectAssignments\(env, GUARDIAN_BATCH_LIMIT\)/,
  "Guardian assignment recovery must use the 50-row repair cap");
assert.match(guardian, /projects_marked_running/, "project running reconciliation missing");
assert.match(guardian, /projects_marked_completed/, "project completion reconciliation missing");
assert.match(guardian, /expired_request_nonces_pruned/, "nonce retention missing");
assert.match(guardian, /old_rate_windows_pruned/, "rate-limit retention missing");
assert.match(guardian, /deepConsistencyWarnings/, "deep consistency scan missing");
assert.match(guardian, /status != 'checking'/, "Guardian must prevent overlapping repair runs");
assert.match(guardian, /w\.status NOT IN \('completed','cancelled'\)/,
  "projects with failed work must not be silently marked completed");

assert.doesNotMatch(guardian, /DROP\s+TABLE/i, "Guardian must never drop tables");
assert.doesNotMatch(guardian, /DELETE\s+FROM\s+(nodes|architect_projects|project_work_items|assignments|results|agent_reports)\b/i,
  "Guardian must not delete business/control records automatically");
assert.match(guardian, /DELETE FROM node_request_nonces[\s\S]*LIMIT \?/,
  "nonce cleanup must be bounded");
assert.match(guardian, /DELETE FROM node_log_rate_limits[\s\S]*LIMIT \?/,
  "rate-window cleanup must be bounded");
assert.match(guardian, /DELETE FROM d1_guardian_actions[\s\S]*OFFSET \?/,
  "Guardian history cleanup must preserve a bounded tail");

assert.match(migration, /CREATE TABLE IF NOT EXISTS d1_guardian_state/, "Guardian state migration missing");
assert.match(migration, /CREATE TABLE IF NOT EXISTS d1_guardian_actions/, "Guardian actions migration missing");

assert.match(index, /\/api\/v1\/architect\/d1-guardian/, "Guardian Architect endpoint missing");
assert.match(index, /force: true/, "manual Guardian run must bypass cadence gate after Architect auth");
assert.match(index, /export async function expireStaleCommands/, "Guardian stale-command hook must be exported");
assert.match(index, /export async function recoverStaleProjectAssignments/, "Guardian assignment recovery hook must be exported");

assert.match(operations, /id="guardianState"/, "Operations Guardian status missing");
assert.match(operations, /id="guardianRun"/, "Operations run-now control missing");
assert.match(operations, /Автоконтроль запускается каждые 5 минут/, "Guardian cadence copy missing");
assert.match(operations, /loadGuardian\(\)/, "Guardian status loader missing");

console.log("D1 Guardian bounded automation guards: OK");
