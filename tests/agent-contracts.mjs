import assert from "node:assert/strict";
import {
  AGENT_CAPABILITY_SCHEMA,
  TASK_ENVELOPE_SCHEMA,
  RESULT_ENVELOPE_SCHEMA,
  buildAgentCapabilityContract,
  buildTaskEnvelope,
  buildResultEnvelope,
  verifyProjectResultEnvelope
} from "../src/agent-contracts.js";

const capability = buildAgentCapabilityContract({
  node_id: "node_demo",
  agent_version: "0.3.20",
  status: "online",
  last_seen_at: "2026-09-29T10:00:00Z",
  capabilities: ["project_text", "project_python", "lmstudio_remote"],
  installed: 1,
  server_running: 1,
  loaded_model: "qwen/example",
  cpu_percent: 12.5,
  memory_percent: 42,
  memory_total_bytes: 16 * 1024 ** 3,
  cpu_logical_count: 8,
  gpus: [{ name: "demo" }]
});

assert.equal(capability.schema, AGENT_CAPABILITY_SCHEMA);
assert.deepEqual(capability.runtime_types, ["python", "lmstudio", "hybrid"]);
assert.equal(capability.model_runtime.loaded_model, "qwen/example");
assert.equal(capability.resources.cpu_logical_count, 8);

const task = buildTaskEnvelope({
  projectId: "project_demo",
  workItemId: "work_demo",
  roleName: "programmer",
  taskText: "Implement a bounded parser.",
  executionMode: "ai",
  nodeId: "node_demo",
  routingReason: "preferred_ready_node"
});
assert.equal(task.schema, TASK_ENVELOPE_SCHEMA);
assert.equal(task.schema_version, 1);
assert.equal(task.attempt, 1);
assert.equal(task.routing.node_id, "node_demo");
assert.equal(task.expected_output.schema, RESULT_ENVELOPE_SCHEMA);

const report = {
  project_id: "project_demo",
  work_item_id: "work_demo",
  role_name: "programmer",
  engine: "lmstudio",
  model: "qwen/example",
  content: "Implemented and checked the parser.",
  completed_at: "2026-09-29T10:01:00Z"
};
const result = buildResultEnvelope({
  projectId: "project_demo",
  workItemId: "work_demo",
  assignmentId: "assignment_work_demo",
  nodeId: "node_demo",
  roleName: "programmer",
  executionMode: "ai",
  outcome: "success",
  report,
  reportSha256: "a".repeat(64),
  reportSizeBytes: 123
});
assert.equal(result.schema, RESULT_ENVELOPE_SCHEMA);
assert.equal(result.model, "qwen/example");

const accepted = verifyProjectResultEnvelope(result, report);
assert.equal(accepted.ok, true);
assert.equal(accepted.status, "accepted");

const badReport = { ...report, work_item_id: "work_other", content: "" };
const rejected = verifyProjectResultEnvelope(result, badReport);
assert.equal(rejected.ok, false);
assert.ok(rejected.reason_codes.includes("work_item_id_mismatch"));
assert.ok(rejected.reason_codes.includes("missing_content"));

const pythonReport = {
  project_id: "project_demo",
  work_item_id: "work_python",
  role_name: "programmer",
  engine: "python",
  model: null,
  content: "Deterministic Python result."
};
const pythonResult = buildResultEnvelope({
  projectId: "project_demo",
  workItemId: "work_python",
  assignmentId: "assignment_work_python",
  nodeId: "node_demo",
  roleName: "programmer",
  executionMode: "python",
  outcome: "success",
  report: pythonReport,
  reportSha256: "b".repeat(64),
  reportSizeBytes: 100
});
assert.equal(verifyProjectResultEnvelope(pythonResult, pythonReport).ok, true);

console.log(JSON.stringify({
  ok: true,
  capability_schema: capability.schema,
  task_schema: task.schema,
  result_schema: result.schema,
  verifier: accepted.verifier
}, null, 2));
