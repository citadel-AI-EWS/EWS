import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const guardian = readFileSync(new URL("../src/d1-guardian.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const operations = readFileSync(new URL("../operations.html", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/0019_d1_guardian.sql", import.meta.url), "utf8");

assert.match(wrangler, /"\*\/5 \* \* \* \*"/);
assert.match(worker, /runD1Guardian\(env/);
assert.match(worker, /controller\?\.cron === "\*\/5 \* \* \* \*"/);
assert.match(worker, /controller\?\.cron === "17 \* \* \* \*"/);
assert.match(guardian, /GUARDIAN_BATCH_LIMIT = 50/);
assert.match(guardian, /stale_nodes_offline/);
assert.match(guardian, /stale_commands_expired/);
assert.match(guardian, /stale_project_assignments_requeued/);
assert.match(guardian, /projects_marked_running/);
assert.match(guardian, /projects_marked_completed/);
assert.match(guardian, /expired_request_nonces_detected/);
assert.match(guardian, /old_rate_windows_detected/);
assert.match(guardian, /deepConsistencyWarnings/);
assert.match(guardian, /status != 'checking'/);
assert.match(guardian, /w\.status NOT IN \('completed','cancelled'\)/);
assert.match(guardian, /expireStaleCommands\(env, null, GUARDIAN_BATCH_LIMIT\)/);
assert.match(guardian, /recoverStaleProjectAssignments\(env, GUARDIAN_BATCH_LIMIT\)/);

const destructive = new RegExp("D" + "ELETE\\s+F" + "ROM", "i");
assert.doesNotMatch(guardian, destructive);
assert.doesNotMatch(guardian, /DROP\s+TABLE/i);
assert.match(guardian, /SELECT rowid[\s\S]*node_request_nonces[\s\S]*LIMIT \?/);
assert.match(guardian, /SELECT rowid[\s\S]*node_log_rate_limits[\s\S]*LIMIT \?/);

assert.match(migration, /CREATE TABLE IF NOT EXISTS d1_guardian_state/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS d1_guardian_actions/);
assert.match(index, /\/api\/v1\/architect\/d1-guardian/);
assert.match(index, /force: true/);
assert.match(operations, /id="guardianState"/);
assert.match(operations, /id="guardianRun"/);
assert.match(operations, /Автоконтроль запускается каждые 5 минут/);
assert.match(operations, /loadGuardian\(\)/);
assert.match(guardian, /d1_write_quota_unavailable/);
assert.match(guardian, /guardian_storage_bootstrap_failed/);
assert.match(guardian, /storage_ready: false/);
assert.match(operations, /Ждёт доступ к записи D1/);
assert.match(operations, /Cloudflare D1 сейчас не принимает записи/);

console.log("D1 Guardian bounded non-destructive automation guards: OK");
