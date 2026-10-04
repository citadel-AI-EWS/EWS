import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const smokeScript = fileURLToPath(new URL("../scripts/smoke_test.mjs", import.meta.url));
const fixtures = {
  "/api/v1/status/d1-usage": {
    ok: true, source: "cloudflare_analytics", status: "ready", usage_percent: 12.5,
    reset_at: "2026-10-05T00:00:00.000Z"
  },
  "/api/health": {
    ok: true, controller_signing: "ready", report_storage: "ready", session_storage: "ready",
    telemetry_storage: "ready", presence_storage: "ready", project_execution: "ready",
    project_online_nodes: 1, project_ai_ready_workers: 1, project_python_ready_workers: 1,
    project_readiness_error: null, openrouter_quality: "unconfigured"
  },
  "/api/v1/hub/nodes": {
    ok: true, nodes: [{node_id: "local-smoke-fixture", status: "online", agent_version: "0.3.38"}]
  },
  "/api/v1": {ok: true, arbitrary_remote_execution: false, command_types: ["update"]},
  "/": '<!doctype html><section id="machines"><form id="taskForm"></form></section>'
};

async function runSmoke(baseUrl, overrides = {}) {
  const started = performance.now();
  const child = spawn(process.execPath, [smokeScript, baseUrl], {
    env: {
      ...process.env, DEPLOY_SHA: "local-smoke-integration", SMOKE_ATTEMPTS: "1",
      SMOKE_DELAY_MS: "10", SMOKE_REQUEST_TIMEOUT_MS: "1000", ...overrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "", killed = false;
  child.stdout.setEncoding("utf8").on("data", text => {stdout += text;});
  child.stderr.setEncoding("utf8").on("data", text => {stderr += text;});
  const deadline = setTimeout(() => {killed = true; child.kill("SIGKILL");}, 6000);
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({code, signal}));
    });
    return {...exit, stdout, stderr, killed, elapsedMs: performance.now() - started};
  } finally {
    clearTimeout(deadline);
  }
}

async function withServer(intercept, verify, overrides = {}) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push({path: url.pathname, deployment: url.searchParams.get("deployment")});
    if (intercept?.(url.pathname, response)) return;
    const fixture = fixtures[url.pathname];
    if (fixture === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {"content-type": typeof fixture === "string" ? "text/html" : "application/json"});
    response.end(typeof fixture === "string" ? fixture : JSON.stringify(fixture));
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const result = await runSmoke(`http://127.0.0.1:${server.address().port}`, overrides);
    await verify(result, requests);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

await withServer(null, (result, requests) => {
  assert.equal(result.killed, false);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(report.ok, true);
  assert.equal(report.registered_nodes, 1);
  assert.equal(report.project_execution, "ready");
  assert.equal(report.project_online_nodes, 1);
  assert.equal(report.project_ai_ready_workers, 1);
  assert.equal(report.project_python_ready_workers, 1);
  assert.equal(report.d1_usage_percent, 12.5);
  assert.equal(report.openrouter_quality, "unconfigured");
  assert.equal(report.project_readiness_error, null);
  assert.ok(Number.isFinite(Date.parse(report.checked_at)));
  assert.equal(requests.length, 5);
  assert.deepEqual(new Set(requests.map(request => request.path)), new Set(Object.keys(fixtures)));
});

// A timeout must also abort an unfinished JSON/HTML body after headers arrived.
for (const [path, unfinishedBody] of [
  ["/api/v1/status/d1-usage", null],
  ["/api/v1/hub/nodes", '{"ok":'],
  ["/", '<section id="machines">']
]) {
  await withServer((requested, response) => {
    if (requested !== path) return false;
    if (unfinishedBody !== null) {
      response.writeHead(200, {"content-type": path === "/" ? "text/html" : "application/json"});
      response.write(unfinishedBody);
    }
    return true;
  }, (result, requests) => {
    assert.equal(result.killed, false, `${path}: child required forced termination`);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal(result.signal, null);
    assert.ok(result.elapsedMs < 3000, `${path}: ${result.elapsedMs}ms exceeded bounded timeout`);
    assert.match(result.stderr, /smoke attempt 1\/1 failed/);
    assert.match(result.stderr, /CITADEL smoke test failed/);
    assert.equal(requests.filter(request => request.path === path).length, 1);
  }, {SMOKE_REQUEST_TIMEOUT_MS: "100"});
}

for (const kind of ["read", "write"]) {
  const error = `hub_d1_daily_${kind}_limit_exceeded`;
  await withServer((path, response) => {
    if (path !== "/api/v1/hub/nodes") return false;
    response.writeHead(503, {"content-type": "application/json", "retry-after": "3600"});
    response.end(JSON.stringify({ok: false, error, retry_after_seconds: 3600}));
    return true;
  }, (result, requests) => {
    assert.equal(result.killed, false);
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(error));
    assert.match(result.stderr, /smoke attempt 1\/3 failed/);
    assert.doesNotMatch(result.stderr, /smoke attempt [23]\/3/);
    assert.equal(requests.filter(request => request.path === "/api/v1/hub/nodes").length, 1);
    assert.ok(requests.every(request => request.deployment === "local-smoke-integration-1"),
      "daily quota must stop before issuing requests for another attempt");
    for (const path of Object.keys(fixtures)) {
      assert.ok(requests.filter(request => request.path === path).length <= 1,
        `${path} was polled again after daily ${kind} quota exhaustion`);
    }
  }, {SMOKE_ATTEMPTS: "3"});
}

console.log("Deployment smoke integration: success without logs, bounded HTTP timeouts, quota stops: OK");
