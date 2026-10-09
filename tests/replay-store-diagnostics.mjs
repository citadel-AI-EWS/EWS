import assert from "node:assert/strict";
import worker from "../src/index.js";
import {authenticateNode, sha256Hex} from "../src/telemetry/common.js";
import {replayFailureCode} from "../src/replay-diagnostics.js";

const keys = await crypto.subtle.generateKey({name: "Ed25519"}, true, ["sign", "verify"]);
const node = {node_id: "node_diagnostics", public_key: JSON.stringify(await crypto.subtle.exportKey("jwk", keys.publicKey)),
  status: "offline", agent_version: "0.3.41"};
const reads = [];
const env = {DB: {prepare(sql) {
  reads.push(sql);
  return {bind() {return this;}, async first() {
    if (sql.includes("FROM nodes")) return node;
    if (sql.includes("FROM node_request_nonces")) return null;
    throw Error("unexpected_database_operation");
  }};
}}, SSH_RELAY: {idFromName: value => value, get: () => ({fetch: async () => {
  throw Error("Your account exceeded its daily SQLite written rows limit. Bearer private-test-token");
}})}};
async function request(path) {
  const ts = String(Math.floor(Date.now() / 1000)), id = crypto.randomUUID();
  const canonical = ["GET", path, ts, id, await sha256Hex("")].join("\n");
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey,
    new TextEncoder().encode(canonical))).toString("base64url");
  return new Request("https://hub" + path, {headers: {"x-node-id": node.node_id,
    "x-node-timestamp": ts, "x-node-request-id": id, "x-node-signature": signature}});
}
const originalWarn = console.warn, logs = [];
console.warn = (...items) => logs.push(items);
try {
  const result = await worker.fetch(await request("/api/v1/nodes/node_diagnostics/commands"), env);
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error, "node_replay_store_unavailable");
  const telemetry = await request("/api/v1/nodes/node_diagnostics/logs");
  await assert.rejects(authenticateNode(telemetry, env, node.node_id, new URL(telemetry.url), new Uint8Array()),
    error => error.code === "node_replay_store_unavailable");
  assert.ok(logs.some(items => items[1] === "replay_storage_daily_write_limit"));
  assert.ok(!JSON.stringify(logs).includes("private-test-token"));
  assert.ok(reads.every(sql => !/INSERT|UPDATE|DELETE/.test(sql)), "an ambiguous DO failure must never fall back to D1 writes");
  assert.equal(replayFailureCode(new Error("D1_ERROR: daily row read limit exceeded")), "replay_d1_daily_read_limit");
  assert.equal(replayFailureCode(new Error("private unknown diagnostics")), "replay_transport_unavailable");
} finally {console.warn = originalWarn;}
console.log("Signed control and telemetry: private replay failure diagnostics, unchanged fail-closed auth, no D1 fallback: PASS");
