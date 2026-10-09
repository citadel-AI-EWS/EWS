import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {googleDriveNodeReportWriteTest, googleDriveNodeReportFingerprint} from "../src/index.js";
import {enqueueNodeReports, drainNodeReports, nodeReportsEnabled, REPORT_LIMITS} from "../src/node-reports.js";
import {classifyTailEvent, jsonObjectStream, tailFailureCategories} from "../scripts/agent_connectivity_evidence.mjs";
import {ingestNodeLogs} from "../src/telemetry/ingest.js";
import {sha256Hex} from "../src/telemetry/common.js";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("CREATE TABLE nodes (node_id TEXT PRIMARY KEY, hostname TEXT); INSERT INTO nodes VALUES ('node_a15', 'a15')");
function statement(sql, args = []) {
  return {bind: (...values) => statement(sql, values),
    async run() {const result = sqlite.prepare(sql).run(...args); return {meta: {changes: Number(result.changes)}};},
    async first() {return sqlite.prepare(sql).get(...args) || null;},
    async all() {return {results: sqlite.prepare(sql).all(...args)};}};
}
const DB = {prepare: statement, async batch(statements) {
  sqlite.exec("BEGIN");
  try {const result = []; for (const stmt of statements) result.push(await stmt.run()); sqlite.exec("COMMIT"); return result;}
  catch (error) {sqlite.exec("ROLLBACK"); throw error;}
}};
const env = {DB, GOOGLE_DRIVE_ACCESS_TOKEN: "fixture-only-token", GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID: "root-folder"};
const originalFetch = globalThis.fetch;
const files = new Map();
let nextId = 0, mode = "ok", creates = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.equal(init.headers.authorization, "Bearer fixture-only-token");
  if (url.pathname.endsWith("/generateIds")) return Response.json({ids: ["generated_" + ++nextId]});
  if (url.searchParams.has("q")) {
    assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true");
    return Response.json({files: [{id: "child-folder", name: "a15__node_a15"},
      {id: "test-folder", name: "Проверка записи__drive-write-test"}]});
  }
  if (url.pathname === "/drive/v3/files" && init.method === "POST") {
    assert.equal(url.searchParams.get("supportsAllDrives"), "true");
    return Response.json({id: "child-folder"});
  }
  if (url.pathname === "/upload/drive/v3/files") {
    assert.equal(url.searchParams.get("supportsAllDrives"), "true");
    if (mode === "quota") return Response.json({error: {errors: [{reason: "storageQuotaExceeded"}]}}, {status: 403});
    const parts = String(init.body).split("\r\n\r\n");
    const meta = JSON.parse(parts[1].split("\r\n--")[0]);
    const body = parts[2].split("\r\n--")[0];
    if (files.has(meta.id)) return new Response(null, {status: 409});
    creates++;
    files.set(meta.id, body);
    if (mode === "lost") throw new Error("lost_response_with_secret_that_must_not_be_logged");
    return Response.json({id: meta.id});
  }
  if (url.searchParams.get("alt") === "media") {
    const id = url.pathname.split("/").at(-1);
    return new Response(mode === "tamper" ? "tampered" : files.get(id));
  }
  throw new Error("unexpected_drive_fixture_request");
};
const events = [{event_id: "event-1", event_type: "lmstudio_model_loaded", level: "info",
  created_at: "2026-10-09T07:20:00Z", message: "Модель загружена token=private-value",
  details: {model: "Qwen", private_key: "fixture-private", connection: "ok"}}];
const row = () => sqlite.prepare("SELECT * FROM node_report_outbox WHERE node_id = 'node_a15'").get();
try {
  assert.equal(await nodeReportsEnabled(env), false);
  assert.deepEqual(await enqueueNodeReports(env, "node_a15", events), {status: "awaiting_write_test"});
  await assert.rejects(googleDriveNodeReportWriteTest({}), error => error.code === "drive_credentials_missing");
  mode = "tamper";
  await assert.rejects(googleDriveNodeReportWriteTest(env), error => error.code === "drive_report_readback_mismatch");
  mode = "quota";
  await assert.rejects(googleDriveNodeReportWriteTest(env), error => error.code === "drive_storage_quota_exceeded");
  mode = "ok";
  const proof = await googleDriveNodeReportWriteTest(env);
  assert.equal(proof.live_write_verified, true);
  assert.equal(proof.fingerprint, await googleDriveNodeReportFingerprint(env));
  env.GOOGLE_DRIVE_NODE_REPORTS_VERIFICATION = JSON.stringify(proof);
  assert.equal(await nodeReportsEnabled(env), true);
  assert.equal(await nodeReportsEnabled({...env, GOOGLE_DRIVE_ACCESS_TOKEN: "rotated"}), false);
  assert.equal(await nodeReportsEnabled({...env, GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID: "other-folder"}), false);
  await enqueueNodeReports(env, "node_a15", events);
  const originalBody = row().report_json;
  assert.ok(originalBody.includes("Модель загружена"));
  assert.ok(!originalBody.includes("fixture-private"));
  assert.ok(!originalBody.includes("private-value"));
  const retry = await enqueueNodeReports(env, "node_a15", events);
  assert.equal(retry.duplicate, true);
  // A lease survives process interruption; an independent sender cannot claim
  // the same batch until it expires, including when uploads are slow.
  const now = Date.now();
  sqlite.prepare("UPDATE node_report_outbox SET lease_until = ?").run(now + REPORT_LIMITS.lease_ms);
  assert.equal((await drainNodeReports(env, {now})).delivered, 0);
  const initialCreates = creates;
  mode = "lost";
  const first = await drainNodeReports(env, {now: now + REPORT_LIMITS.lease_ms + 1});
  assert.equal(first.failed, 1);
  assert.equal(row().report_json, originalBody);
  assert.equal(row().last_error_code, "drive_payload_storage_unavailable");
  assert.ok(row().drive_file_id);
  assert.equal(creates, initialCreates + 1);
  mode = "ok";
  assert.equal((await drainNodeReports(env, {now: row().next_attempt_at - 1})).delivered, 0);
  assert.equal((await drainNodeReports(env, {now: row().next_attempt_at})).delivered, 1);
  assert.equal(creates, initialCreates + 1, "retry reuses the persisted file ID");
  assert.equal(row().report_json, "", "temporary body removed only after hash verification");
  assert.equal(row().size_bytes, 0);
  assert.equal((await enqueueNodeReports(env, "node_a15", events)).status, "delivered");
  // Backpressure refuses to advance the agent cursor. Duplicates still pass.
  sqlite.prepare(`INSERT INTO node_report_outbox
    (batch_id,node_id,report_json,sha256,size_bytes,created_at) VALUES ('full','other','{}','hash',?,?)`)
    .run(REPORT_LIMITS.pending_bytes, events[0].created_at);
  await assert.rejects(enqueueNodeReports(env, "node_a15", [{...events[0], event_id: "new"}]),
    error => error.status === 503 && error.code === "node_report_queue_full");
  assert.equal((await enqueueNodeReports(env, "node_a15", events)).duplicate, true);
  // Exercise the signed HTTP ingestion boundary with real SQLite and Ed25519.
  // Routine events discarded by local retention must still reach the outbox.
  sqlite.exec("ALTER TABLE nodes ADD COLUMN public_key TEXT; ALTER TABLE nodes ADD COLUMN status TEXT DEFAULT 'online'; ALTER TABLE nodes ADD COLUMN agent_version TEXT DEFAULT '0.3.41'");
  const keys = await crypto.subtle.generateKey({name: "Ed25519"}, true, ["sign", "verify"]);
  sqlite.prepare("UPDATE nodes SET public_key = ? WHERE node_id = 'node_a15'")
    .run(JSON.stringify(await crypto.subtle.exportKey("jwk", keys.publicKey)));
  async function signedLogs(eventId, valid = true) {
    const path = "/api/v1/nodes/node_a15/logs";
    const body = JSON.stringify({events: [{...events[0], event_type: "agent_start", event_id: eventId}]});
    const ts = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomUUID();
    const canonical = ["POST", path, ts, nonce, await sha256Hex(body)].join("\n");
    const signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey,
      new TextEncoder().encode(valid ? canonical : "invalid"))).toString("base64url");
    return new Request("https://hub" + path, {method: "POST", body, headers: {
      "x-node-id": "node_a15", "x-node-timestamp": ts, "x-node-request-id": nonce, "x-node-signature": signature}});
  }
  const invalid = await signedLogs("unauthenticated", false);
  await assert.rejects(ingestNodeLogs(invalid, env, "node_a15", new URL(invalid.url)), error => error.code === "invalid_signature");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM node_report_outbox").get().n, 2);
  const blocked = await signedLogs("blocked-routine");
  await assert.rejects(ingestNodeLogs(blocked, env, "node_a15", new URL(blocked.url)), error => error.code === "node_report_queue_full");
  sqlite.exec("DELETE FROM node_report_outbox WHERE batch_id = 'full'");
  const signed = await signedLogs("routine-archived");
  const accepted = await ingestNodeLogs(signed, env, "node_a15", new URL(signed.url));
  const result = await accepted.json();
  assert.equal(result.discarded, 1);
  assert.equal(result.drive_archive.status, "queued");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM node_logs").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM node_report_outbox WHERE state='pending'").get().n, 1);

  const privateTail = {event: {request: {url: "https://hub/api/v1/nodes/private-node/sync?token=secret",
    method: "POST", headers: {authorization: "secret"}}, response: {status: 401}}, outcome: "ok"};
  assert.deepEqual(classifyTailEvent(privateTail), {route: "sync", method: "POST", status: 401, outcome: "ok"});
  const parsed = [];
  const stream = jsonObjectStream(value => parsed.push(classifyTailEvent(value)));
  const json = JSON.stringify({...privateTail, logs: [{message: "brace } { in a quoted string"}]}, null, 2);
  for (let offset = 0; offset < json.length; offset += 7) stream(json.slice(offset, offset + 7));
  assert.equal(parsed.length, 1);
  assert.ok(!JSON.stringify(parsed).includes("secret"));
  assert.equal(classifyTailEvent({event: {request: {url: "https://hub/api/health?connectivity_probe=1"}}}).probe, true);
  assert.equal(classifyTailEvent({event: {request: {url: "https://hub/api/v1/nodes/private-node/ai-state"}}}).route, "ai-state");
  assert.equal(classifyTailEvent({event: {request: {url: "https://hub/api/v1/nodes/private-node/future/private-id"}}}).route, "other_node_route");
  assert.deepEqual(tailFailureCategories({entrypoint: "NodeSshRelay", exceptions: [
    {message: "SQLITE_FULL: private diagnostics Bearer private-secret"}]}), ["relay:storage_sqlite_limit"]);
  assert.deepEqual(tailFailureCategories({exceptions: [{message: "D1_ERROR: daily row write limit exceeded"}]}),
    ["worker:storage_daily_write_limit"]);
} finally {globalThis.fetch = originalFetch; sqlite.close();}
console.log("Node reports: write/readback gate, secret redaction, durable retry, deduplication, lease and backpressure: OK");
