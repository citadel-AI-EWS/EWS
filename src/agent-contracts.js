export const AGENT_CAPABILITY_SCHEMA = "citadel.agent-capability.v1";
export const TASK_ENVELOPE_SCHEMA = "citadel.task-envelope.v1";
export const RESULT_ENVELOPE_SCHEMA = "citadel.result-envelope.v1";

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function buildAgentCapabilityContract(node = {}) {
  const capabilities = uniqueStrings(node.capabilities || node.capabilities_json || []);
  const runtimeTypes = [];
  if (capabilities.includes("project_python")) runtimeTypes.push("python");
  if (capabilities.includes("project_text") || capabilities.includes("lmstudio_remote")) runtimeTypes.push("lmstudio");
  if (runtimeTypes.includes("python") && runtimeTypes.includes("lmstudio")) runtimeTypes.push("hybrid");

  const loadedModel = typeof node.loaded_model === "string" && node.loaded_model.trim()
    ? node.loaded_model.trim()
    : null;
  const serverRunning = Number(node.server_running || 0) === 1;
  const installed = Number(node.installed || 0) === 1;

  return {
    schema: AGENT_CAPABILITY_SCHEMA,
    schema_version: 1,
    node_id: typeof node.node_id === "string" ? node.node_id : null,
    agent_version: typeof node.agent_version === "string" ? node.agent_version : null,
    runtime_types: runtimeTypes,
    capabilities,
    model_runtime: {
      provider: "lmstudio",
      installed,
      server_running: serverRunning,
      loaded_model: loadedModel
    },
    resources: {
      cpu_percent: nullableNumber(node.cpu_percent),
      memory_percent: nullableNumber(node.memory_percent),
      memory_total_bytes: nullableNumber(node.memory_total_bytes),
      cpu_logical_count: nullableNumber(node.cpu_logical_count),
      gpus: Array.isArray(node.gpus) ? node.gpus : []
    },
    health: {
      status: typeof node.status === "string" ? node.status : null,
      last_seen_at: typeof node.last_seen_at === "string" ? node.last_seen_at : null
    }
  };
}

export function buildTaskEnvelope({
  projectId,
  workItemId,
  roleName,
  taskText,
  executionMode,
  attempt = 1,
  nodeId = null,
  routingReason = null
}) {
  return {
    schema: TASK_ENVELOPE_SCHEMA,
    schema_version: 1,
    project_id: String(projectId || ""),
    work_item_id: String(workItemId || ""),
    role_name: String(roleName || "planner"),
    goal: String(taskText || ""),
    execution_mode: executionMode === "python" ? "python" : "ai",
    attempt: Math.max(1, Number.parseInt(String(attempt || 1), 10) || 1),
    routing: {
      node_id: typeof nodeId === "string" && nodeId ? nodeId : null,
      reason: typeof routingReason === "string" && routingReason ? routingReason : null
    },
    expected_output: {
      type: "project_report",
      schema: RESULT_ENVELOPE_SCHEMA
    }
  };
}

export function buildResultEnvelope({
  projectId,
  workItemId,
  assignmentId,
  nodeId,
  roleName,
  executionMode,
  outcome,
  report,
  reportSha256,
  reportSizeBytes,
  createdAt = null
}) {
  const reportObject = report && typeof report === "object" && !Array.isArray(report) ? report : {};
  return {
    schema: RESULT_ENVELOPE_SCHEMA,
    schema_version: 1,
    project_id: String(projectId || ""),
    work_item_id: String(workItemId || ""),
    assignment_id: String(assignmentId || ""),
    node_id: String(nodeId || ""),
    role_name: String(roleName || "planner"),
    execution_mode: executionMode === "python" ? "python" : "ai",
    outcome: String(outcome || ""),
    engine: typeof reportObject.engine === "string" ? reportObject.engine : null,
    model: typeof reportObject.model === "string" && reportObject.model ? reportObject.model : null,
    report_sha256: typeof reportSha256 === "string" ? reportSha256 : null,
    report_size_bytes: nullableNumber(reportSizeBytes),
    completed_at: typeof reportObject.completed_at === "string"
      ? reportObject.completed_at
      : (typeof createdAt === "string" ? createdAt : null)
  };
}

export function verifyProjectResultEnvelope(envelope, report) {
  const checks = [];
  const fail = (code) => checks.push(code);

  if (!envelope || envelope.schema !== RESULT_ENVELOPE_SCHEMA || envelope.schema_version !== 1) {
    fail("invalid_result_envelope");
  }
  if (!envelope?.project_id) fail("missing_project_id");
  if (!envelope?.work_item_id) fail("missing_work_item_id");
  if (!envelope?.assignment_id) fail("missing_assignment_id");
  if (!envelope?.node_id) fail("missing_node_id");

  const reportObject = report && typeof report === "object" && !Array.isArray(report) ? report : null;
  if (!reportObject) {
    fail("report_not_object");
  } else {
    if (reportObject.project_id && reportObject.project_id !== envelope.project_id) fail("project_id_mismatch");
    if (reportObject.work_item_id && reportObject.work_item_id !== envelope.work_item_id) fail("work_item_id_mismatch");
    if (reportObject.role_name && reportObject.role_name !== envelope.role_name) fail("role_name_mismatch");
    if (envelope.outcome !== "failed") {
      if (typeof reportObject.content !== "string" || !reportObject.content.trim()) fail("missing_content");
    }
    if (envelope.execution_mode === "ai" && envelope.outcome !== "failed") {
      if (reportObject.engine && reportObject.engine !== "lmstudio") fail("unexpected_ai_engine");
      if (!envelope.model) fail("missing_model");
    }
    if (envelope.execution_mode === "python" && reportObject.engine && reportObject.engine !== "python") {
      fail("unexpected_python_engine");
    }
  }

  return {
    ok: checks.length === 0,
    status: checks.length === 0 ? "accepted" : "rejected",
    verifier: "structural_v1",
    reason_codes: checks
  };
}
