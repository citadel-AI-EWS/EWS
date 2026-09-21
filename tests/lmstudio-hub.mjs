import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import worker from "../src/index.js";

// Execute the actual Hub functions with a small DOM and controlled HTTP responses.
const html = await readFile(new URL("../hub.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const source = script.slice(0, script.indexOf('    $("lmstudioClose").addEventListener'));
const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, {
      value: "", textContent: "", hidden: false, disabled: false, style: {},
      classList: {
        contains: (name) => classes.has(name),
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name)
      }
    });
  }
  return elements.get(id);
}
let respond = async () => new Response(JSON.stringify({ ok: true, ai: {} }));
const context = vm.createContext({
  document: { getElementById: element, querySelectorAll: () => [] },
  sessionStorage: { getItem: () => "test-token" },
  localStorage: { getItem: () => "ru" },
  location: { search: "" }, URLSearchParams, Headers, Response, URL,
  fetch: (...args) => respond(...args),
  setInterval: () => 1, clearInterval: () => {},
  confirm: () => true
});
vm.runInContext(source, context);
vm.runInContext(`
  releaseVersion = "0.3.13";
  lmstudioNodeId = "node_test";
  lastOverview = { nodes: [{
    node_id: "node_test", hostname: "test", status: "online",
    last_seen_at: new Date().toISOString(), agent_version: "0.3.13",
    lmstudio_installed: 1, lmstudio_loaded_model: "test-model",
    lmstudio_server_running: 0
  }], commands: [] };
  refresh = async () => {};
  renderCurrent = () => {};
  toast = () => {};
  syncLmstudioPanel();
`, context);
assert.doesNotMatch(element("lmstudioStatus").textContent, /READY|готов к/,
  "a stopped model server must not be marked ready");
assert.match(element("lmstudioStatus").textContent, /остановлен/);

vm.runInContext("lastOverview.nodes[0].lmstudio_server_running = 1; syncLmstudioPanel();", context);
assert.match(element("lmstudioStatus").textContent, /готов/);
vm.runInContext("lastOverview.nodes[0].status = 'paused'; syncLmstudioPanel();", context);
assert.doesNotMatch(element("lmstudioStatus").textContent, /READY|готов к/);
vm.runInContext("lastOverview.nodes[0].status = 'online';", context);

respond = async () => new Response(JSON.stringify({
  error: "internal_error", request_id: "request-state-123"
}), { status: 500 });
await vm.runInContext("refreshLmstudioState('node_test')", context);
assert.equal(element("lmstudioError").hidden, false);
assert.match(element("lmstudioError").textContent, /request-state-123/);
vm.runInContext("syncLmstudioPanel()", context);
assert.match(element("lmstudioError").textContent, /request-state-123/,
  "a normal UI refresh must not erase a failed state request");

respond = async () => new Response(JSON.stringify({ ok: true, ai: {
  installed: 1, server_running: 1, loaded_model: "test-model"
} }));
await vm.runInContext("refreshLmstudioState('node_test')", context);
assert.equal(element("lmstudioError").hidden, true);

let releaseCommand;
let posts = 0;
respond = async (_path, options) => {
  if (options.method === "POST") {
    posts += 1;
    return new Promise((resolve) => { releaseCommand = resolve; });
  }
  return new Response(JSON.stringify({ ok: true, ai: {
    installed: 1, server_running: 1, loaded_model: "test-model"
  } }));
};
const command = vm.runInContext("sendLmstudio('lmstudio_probe')", context);
assert.equal(element("lmstudioProbe").disabled, true);
await vm.runInContext("sendLmstudio('lmstudio_probe')", context);
assert.equal(posts, 1, "double-click must not queue the command twice");
releaseCommand(new Response(JSON.stringify({
  error: "internal_error", request_id: "request-command-456"
}), { status: 500 }));
await assert.rejects(command, /internal_error/);
assert.match(element("lmstudioError").textContent, /request-command-456/);
assert.equal(element("lmstudioProbe").disabled, false);
await vm.runInContext("refreshLmstudioState('node_test')", context);
assert.match(element("lmstudioError").textContent, /request-command-456/,
  "successful state polling must not hide a failed command");

vm.runInContext(`lastOverview.nodes.push({
  node_id: "node_other", status: "online", last_seen_at: new Date().toISOString(),
  agent_version: "0.3.13"
}); lmstudioNodeId = "node_other"; syncLmstudioPanel();`, context);
assert.equal(element("lmstudioError").hidden, true, "errors stay with their node");
assert.match(element("lmstudioStatus").textContent, /не получено/);
vm.runInContext(`applyAiSnapshot(lastOverview.nodes[1], {ai: {
  observed: false, installed: 0, server_running: 0, loaded_model: null
}}); syncLmstudioPanel();`, context);
assert.match(element("lmstudioStatus").textContent, /не получено/,
  "missing telemetry must not be presented as a confirmed missing installation");

// An unexpected backend failure is traceable without exposing its details to the browser.
const logs = [];
const originalError = console.error;
let response;
try {
  console.error = (...args) => logs.push(args);
  response = await worker.fetch(new Request("https://example.test/api/v1/architect/nodes/test/ai-state"), {
    ARCHITECT_TOKEN_HASH: "a".repeat(64),
    DB: { prepare() { throw new Error("private database diagnostic"); } }
  });
} finally {
  console.error = originalError;
}
assert.equal(response.status, 500);
assert.equal(response.headers.get("cache-control"), "no-store");
const failure = await response.json();
assert.equal(failure.error, "internal_error");
assert.match(failure.request_id, /^[0-9a-f-]{36}$/);
assert.equal(logs.length, 1);
assert.equal(logs[0][1].request_id, failure.request_id);
assert.doesNotMatch(JSON.stringify(failure), /private database diagnostic/);

console.log("LM Studio readiness, persistent errors and duplicate-click protection: PASS");
