import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";

const SENTINEL = "FLOW_A_SENTINEL_169";
const ARCHITECT_TOKEN = "citadel-test-architect-token";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class D1Statement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) {
    return new D1Statement(this.db, this.sql, bindings);
  }
  first() {
    return this.db.prepare(this.sql).get(...this.bindings) ?? null;
  }
  all() {
    return { results: this.db.prepare(this.sql).all(...this.bindings) };
  }
  run() {
    const result = this.db.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: {
        changes: Number(result.changes || 0),
        last_row_id: Number(result.lastInsertRowid || 0)
      }
    };
  }
}

class D1Database {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new D1Statement(this.db, sql);
  }
  async batch(statements) {
    const results = [];
    this.db.exec("BEGIN");
    try {
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

async function runAgent(configPath, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.env.PYTHON || "python",
      ["agent/citadel_node_v1.py", "once", "--config", configPath],
      { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`agent once failed (${code})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    });
  });
}

function listen(server, host = "127.0.0.1", port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "citadel-flow-a-"));
const binDir = path.join(tempRoot, "bin");
const dataDir = path.join(tempRoot, "state");
await fsPromises.mkdir(binDir, { recursive: true });
await fsPromises.mkdir(dataDir, { recursive: true });

const lmsPath = path.join(binDir, "lms");
await fsPromises.writeFile(
  lmsPath,
  `#!/bin/sh
if [ "$1" = "server" ] && [ "$2" = "status" ]; then
  printf '%s\\n' '{"running":true}'
  exit 0
fi
if [ "$1" = "ps" ]; then
  printf '%s\\n' '[{"identifier":"citadel/test-model"}]'
  exit 0
fi
printf '%s\\n' '{}'
`,
  { mode: 0o755 }
);

const lmServer = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  for await (const _chunk of req) { /* drain request */ }
  const body = JSON.stringify({
    model: "citadel/test-model",
    choices: [{ message: { role: "assistant", content: SENTINEL } }],
    usage: { prompt_tokens: 4, completion_tokens: 4 }
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});
await listen(lmServer, "127.0.0.1", 1234);

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
const migrationDir = path.resolve("migrations");
for (const name of fs.readdirSync(migrationDir).filter((item) => item.endsWith(".sql")).sort()) {
  sqlite.exec(fs.readFileSync(path.join(migrationDir, name), "utf8"));
}
const DB = new D1Database(sqlite);

const driveFiles = new Map();
let driveSequence = 0;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
    const contentType = String(init.headers?.["content-type"] || init.headers?.get?.("content-type") || "");
    const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1];
    assert.ok(boundary, "fake Drive upload missing multipart boundary");
    const body = String(init.body || "");
    const chunks = body.split("--" + boundary).filter((part) => part.includes("Content-Type: application/json"));
    assert.ok(chunks.length >= 2, "fake Drive upload missing JSON content part");
    const payloadPart = chunks[chunks.length - 1];
    const payload = payloadPart.slice(payloadPart.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
    const id = "drive_test_" + (++driveSequence);
    driveFiles.set(id, payload);
    return new Response(JSON.stringify({ id, name: id + ".json", size: String(Buffer.byteLength(payload)) }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  const media = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)\?alt=media$/.exec(url);
  if (media) {
    const id = decodeURIComponent(media[1]);
    if (!driveFiles.has(id)) return new Response("missing", { status: 404 });
    return new Response(driveFiles.get(id), { status: 200, headers: { "content-type": "application/json" } });
  }
  const deletion = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)$/.exec(url);
  if (deletion && String(init.method || "GET").toUpperCase() === "DELETE") {
    driveFiles.delete(decodeURIComponent(deletion[1]));
    return new Response(null, { status: 204 });
  }
  throw new Error("unexpected external fetch in FLOW-A E2E: " + url);
};

const env = {
  DB,
  ARCHITECT_TOKEN_HASH: createHash("sha256").update(ARCHITECT_TOKEN).digest("hex"),
  GOOGLE_DRIVE_ACCESS_TOKEN: "flow-a-test-drive-token",
  GOOGLE_DRIVE_REPORTS_FOLDER_ID: "flow-a-test-folder",
  ASSETS: { fetch: () => new Response("not found", { status: 404 }) }
};
const background = [];
const executionCtx = {
  waitUntil(promise) {
    background.push(Promise.resolve(promise));
  }
};

const controllerServer = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const port = controllerServer.address().port;
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body
    });
    const response = await worker.fetch(request, env, executionCtx);
    const responseBody = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(responseBody);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(error?.stack || error));
  }
});
const controllerAddress = await listen(controllerServer);
const controllerUrl = `http://127.0.0.1:${controllerAddress.port}`;

const configPath = path.join(tempRoot, "config.json");
await fsPromises.writeFile(configPath, JSON.stringify({
  controller_url: controllerUrl,
  data_dir: dataDir,
  poll_seconds: 5,
  heartbeat_seconds: 10,
  request_timeout_seconds: 10,
  max_cpu_percent: 100,
  max_memory_percent: 100,
  prevent_automatic_sleep: false,
  network_recovery_enabled: false
}, null, 2));

const agentEnv = {
  ...process.env,
  PATH: binDir + path.delimiter + (process.env.PATH || "")
};

try {
  await runAgent(configPath, agentEnv);

  const nodes = sqlite.prepare("SELECT node_id, status, agent_version FROM nodes").all();
  assert.equal(nodes.length, 1, "first agent cycle must enroll exactly one node");
  const nodeId = nodes[0].node_id;
  const ai = sqlite.prepare("SELECT installed, server_running, loaded_model FROM node_ai_state WHERE node_id = ?").get(nodeId);
  assert.equal(Number(ai?.installed), 1, "LM Studio must be scheduler-visible as installed");
  assert.equal(Number(ai?.server_running), 1, "LM Studio fake server must be scheduler-visible as running");
  assert.equal(ai?.loaded_model, "citadel/test-model");

  const createResponse = await nativeFetch(controllerUrl + "/api/v1/architect/projects", {
    method: "POST",
    headers: {
      authorization: "Bearer " + ARCHITECT_TOKEN,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      title: "FLOW-A executable gate",
      task_text: "Return the sentinel from the local model.",
      source_type: "architect_manual",
      worker_target: 1
    })
  });
  assert.equal(createResponse.status, 201, await createResponse.text());
  const created = await createResponse.json();
  const projectId = created.project.project_id;
  assert.ok(projectId);

  await runAgent(configPath, agentEnv);

  let report;
  for (let attempt = 0; attempt < 10; attempt++) {
    const projectResponse = await nativeFetch(
      controllerUrl + "/api/v1/architect/projects/" + encodeURIComponent(projectId),
      { headers: { authorization: "Bearer " + ARCHITECT_TOKEN } }
    );
    assert.equal(projectResponse.status, 200, await projectResponse.text());
    report = await projectResponse.json();
    if (report.project?.final_report?.ready) break;
    await sleep(50);
  }

  assert.equal(report.project.final_report.ready, true, JSON.stringify(report.project.execution));
  assert.match(report.project.final_report.combined_text, new RegExp(SENTINEL));
  assert.equal(report.project.execution.completed_work_items, report.project.execution.total_work_items);
  assert.equal(report.project.execution.detail, "all_project_work_items_completed");
  console.log("FLOW A executable E2E: prompt -> real agent -> fake LM Studio :1234 -> final report: PASS");
} finally {
  await Promise.allSettled(background);
  globalThis.fetch = nativeFetch;
  await close(controllerServer);
  await close(lmServer);
  sqlite.close();
  await fsPromises.rm(tempRoot, { recursive: true, force: true });
}
